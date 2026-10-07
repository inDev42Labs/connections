// THROWAWAY. Run from repository root: bun experiments/lifecycle/demo.ts
import assert from 'node:assert/strict'
import { Cause, Effect, Exit, Layer, ManagedRuntime, Redacted, Result } from 'effect'
import { FakeProvider, initialTokens } from './fakes'
import { FakeDatabase, LEASE } from './store'
import { Fault, InspectionStore, makeManager, Provider, Store, Worker } from './model'
import type { Point, Policy, Tokens } from './model'

let workers = 0
let directRequests = 0
function fixture(policy: Policy = { kind: 'strict' }, enrolled = true, tokens: Tokens = initialTokens()) {
  const db = new FakeDatabase(enrolled ? tokens : null)
  const provider = new FakeProvider(policy, () => db.now)
  const spawn = (at: (point: Point) => Effect.Effect<void, Fault> = () => Effect.void) => {
    const name = `worker-${++workers}`
    let requests = 0
    const context = { request: () => `${name}/${++requests}`, at }
    const runtime = ManagedRuntime.make(Layer.mergeAll(
      Layer.succeed(Store, db.client()), Layer.succeed(InspectionStore, { inspect: db.client().inspect }),
      Layer.succeed(Provider, provider.service()), Layer.succeed(Worker, context),
    ))
    return { manager: makeManager(), runtime }
  }
  // Every invocation constructs and disposes a manager, client/context, and runtime.
  const run = async <A, E>(program: (manager: ReturnType<typeof makeManager>) => Effect.Effect<A, E, Store | Provider | Worker | InspectionStore>) => {
    const worker = spawn()
    try { return await worker.runtime.runPromise(program(worker.manager)) }
    finally { await worker.runtime.dispose() }
  }
  const pause = async (point: Point, authorization?: { id: string; binding: string }) => {
    let reached!: () => void
    const gate = new Promise<void>((resolve) => { reached = resolve })
    let release!: () => void
    const released = new Promise<void>((resolve) => { release = resolve })
    const worker = spawn((where) => where === point
      ? Effect.andThen(Effect.sync(reached), Effect.promise(() => released)) : Effect.void)
    const controller = new AbortController()
    const program: Effect.Effect<unknown, Fault, Store | Provider | Worker> = authorization
      ? worker.manager.completeAuthorization(authorization.id, authorization.binding)
      : worker.manager.credentials()
    const result = worker.runtime.runPromiseExit(program, { signal: controller.signal })
    await gate
    return { stop: async () => {
      controller.abort()
      const exit = await result
      assert.ok(Exit.isFailure(exit) && Cause.hasInterrupts(exit.cause))
      await worker.runtime.dispose()
    }, resume: async () => {
      release()
      const exit = await result
      assert.ok(Exit.isSuccess(exit), 'Current worker must finish')
      await worker.runtime.dispose()
    }, resumeStale: async () => {
      release()
      const exit = await result
      assert.ok(Exit.isFailure(exit) && !Cause.hasInterrupts(exit.cause), 'Late worker must fail, not save or return credentials')
      await worker.runtime.dispose()
    } }
  }
  return { db, provider, run, pause }
}
async function expectCode<A, R>(effect: Effect.Effect<A, Fault, R>, run: (effect: Effect.Effect<Result.Result<A, Fault>, never, R>) => Promise<Result.Result<A, Fault>>, code: Fault['code']) {
  const result = await run(Effect.result(effect))
  assert.ok(Result.isFailure(result), `Expected ${code}`)
  assert.equal(result.failure.code, code)
}
const direct = <A>(effect: Effect.Effect<A, Fault>) => Effect.runPromise(effect)
const rejects = <A>(effect: Effect.Effect<A, Fault>, code: Fault['code']) => expectCode(effect, Effect.runPromise, code)
async function credentialsFail(f: ReturnType<typeof fixture>, code: Fault['code']) {
  const result = await f.run((m) => Effect.result(m.credentials()))
  assert.ok(Result.isFailure(result))
  assert.equal(result.failure.code, code)
}

async function run() {
  {
    const f = fixture()
    const attempt = await f.run((m) => m.startAuthorization('session', 'replace'))
    f.db.loseNextAck('consume')
    await f.run((m) => m.completeAuthorization(attempt.id, 'session'))
    const replay = await f.run((m) => Effect.result(m.completeAuthorization(attempt.id, 'session')))
    assert.ok(Result.isFailure(replay) && replay.failure.code === 'invalid-attempt')
    assert.equal(f.provider.exchanges, 1)
    console.log('PASS lost consume ACK recovers same invocation; callback replay cannot exchange twice')
  }
  for (const point of ['claimed', 'reserved', 'response', 'staged'] as const) {
    const f = fixture()
    const stopped = await f.pause(point)
    await stopped.stop() // genuinely interrupted Effect and disposed runtime, not one-stack retry
    assert.equal(f.db.snapshot().operation?.sends, point === 'claimed' ? 0 : 1)
    f.db.advance(LEASE)
    if (point === 'reserved' || point === 'response') {
      await credentialsFail(f, 'attention')
      assert.equal(f.provider.calls, point === 'reserved' ? 0 : 1)
      assert.equal((await f.run((m) => m.inspect())).attention, true)
    } else {
      const tokens = await f.run((m) => m.credentials())
      assert.equal(Redacted.value(tokens.accessToken), 'FAKE-access-1')
      assert.equal(f.provider.calls, 1)
    }
    console.log(`PASS strict worker loss at ${point}: ${point === 'claimed' || point === 'staged' ? 'recovered' : 'attention, no replay'}`)
  }

  for (const policy of [{ kind: 'reusable' }, { kind: 'conditional', window: 50 }] as const) {
    const f = fixture(policy)
    f.provider.loseResponses = 2
    await credentialsFail(f, 'unknown')
    const original = f.db.snapshot().operation!
    for (let i = 0; i < 2; i++) {
      f.db.advance(LEASE)
      if (i === 0) await credentialsFail(f, 'unknown')
      else await f.run((m) => m.credentials())
    }
    const recovered = f.db.snapshot().operation!
    assert.equal(recovered.id, original.id)
    assert.equal(recovered.firstSend, original.firstSend)
    assert.equal(recovered.sends, 3)
    assert.equal(recovered.done, true)
    assert.equal(f.provider.calls, 3)
    console.log(`PASS ${policy.kind}: fresh workers recover with original first-send and total budget`)
  }
  {
    const f = fixture({ kind: 'reusable' })
    f.provider.loseResponses = 9
    for (let i = 0; i < 3; i++) { await credentialsFail(f, 'unknown'); f.db.advance(LEASE) }
    await credentialsFail(f, 'attention')
    f.db.advance(LEASE)
    await credentialsFail(f, 'attention')
    assert.equal(f.provider.calls, 3)
    assert.equal(f.db.snapshot().operation?.sends, 3)
    console.log('PASS exhausted budget cannot reset across replacement workers')
  }
  for (const condition of ['window', 'expiry'] as const) {
    const f = fixture({ kind: 'conditional', window: condition === 'window' ? 20 : 20_000 })
    f.provider.loseResponses = 1
    await credentialsFail(f, 'unknown')
    f.db.advance(condition === 'window' ? 20 : 9900)
    await credentialsFail(f, 'attention')
    assert.equal(f.provider.calls, 1)
    console.log(`PASS conditional ${condition} boundary denies replay`)
  }

  {
    const f = fixture()
    f.provider.loseResponses = 1
    await credentialsFail(f, 'unknown')
    f.db.advance(LEASE)
    await credentialsFail(f, 'attention')
    assert.equal(f.provider.processed, 1)
    assert.equal(f.provider.calls, 1)
    console.log('PASS strict lost provider response remains uncertain, never replayed')
  }
  {
    const f = fixture()
    const paused = await f.pause('staged')
    await paused.stop()
    f.db.advance(1000)
    const credentials = await f.run((m) => m.credentials())
    assert.equal(Redacted.value(credentials.accessToken), 'FAKE-access-2')
    assert.equal(f.db.history().length, 2)
    assert.equal(f.provider.calls, 2, 'Finish stale staged response, then use its replacement refresh token')
    console.log('PASS aged staged access token is committed then refreshed, never returned expired')
  }

  // Lost acknowledgements retry exactly one claim/reservation/stage/completion.
  for (const method of ['claim', 'renew', 'checkpoint', 'complete']) {
    const f = fixture()
    f.db.loseNextAck(method)
    await f.run((m) => m.credentials())
    assert.equal(f.db.history().length, 1)
    assert.equal(f.db.snapshot().operation?.sends, 1)
    assert.equal(f.provider.calls, 1)
    console.log(`PASS lost ${method} acknowledgement is idempotent`)
  }
  {
    const f = fixture()
    const store = f.db.client()
    const revision = f.db.snapshot().revision
    f.db.loseNextAck('claim')
    await rejects(store.claim('lost', revision, { kind: 'strict' }, 3), 'ack-lost')
    const first = f.db.snapshot().operation!
    f.db.advance(LEASE)
    await rejects(store.claim('lost', revision, { kind: 'strict' }, 3), 'conflict')
    assert.equal(f.db.snapshot().operation?.owner?.until, first.owner?.until)
    const next = await direct(store.claim('new', f.db.snapshot().revision, { kind: 'reusable' }, 99))
    assert.deepEqual(f.db.snapshot().operation?.policy, { kind: 'strict' })
    assert.equal(f.db.snapshot().operation?.maxSends, 3)
    const old = { operation: first.id, generation: first.generation, fence: first.owner!.fence }
    await rejects(store.claim('lost', revision, { kind: 'strict' }, 3), 'conflict')
    await rejects(store.renew(old, 'late'), 'conflict')
    await rejects(store.checkpoint(old, 'late', { kind: 'send', expectedSends: 0, notAfter: 10_000 }), 'conflict')
    await rejects(store.complete(old, 'late'), 'conflict')
    f.db.advance(5)
    f.db.loseNextAck('renew')
    await rejects(store.renew(next, 'extend'), 'ack-lost')
    const until = f.db.snapshot().operation?.owner?.until
    f.db.advance(1)
    await direct(store.renew(next, 'extend'))
    assert.equal(f.db.snapshot().operation?.owner?.until, until, 'Renewal retry must not extend twice')
    await rejects(store.claim('contender', f.db.snapshot().revision, { kind: 'strict' }, 3), 'busy')
    f.db.advance(9)
    await rejects(store.renew(next, 'resurrect'), 'conflict')
    console.log('PASS claim receipt cannot resurrect; transfer fences late writes; renewal is bounded and retry-safe')
  }
  {
    const f = fixture()
    const s = f.db.client()
    const ticket = await direct(s.claim('owner', 0, { kind: 'strict' }, 3))
    const reservation = { kind: 'send', expectedSends: 0, notAfter: 10_000 } as const
    await direct(s.checkpoint(ticket, 'reserve', reservation))
    f.db.advance(1)
    await direct(s.checkpoint(ticket, 'reserve', reservation))
    assert.equal(f.db.snapshot().operation?.firstSend, 100)
    assert.equal(f.db.snapshot().operation?.sends, 1)
    await rejects(s.checkpoint(ticket, 'reserve', { kind: 'send', expectedSends: 1, notAfter: 10_000 }), 'conflict')
    const stage = { kind: 'stage', tokens: { ...initialTokens(), access: 'FAKE-staged' } } as const
    f.db.loseNextAck('checkpoint')
    await rejects(s.checkpoint(ticket, 'stage', stage), 'ack-lost')
    await direct(s.checkpoint(ticket, 'stage', stage))
    await rejects(s.checkpoint(ticket, 'stage', { ...stage, tokens: initialTokens() }), 'conflict')
    await direct(s.complete(ticket, 'done'))
    await direct(s.complete(ticket, 'done'))
    const generation = f.db.snapshot().generation
    await direct(s.remove('remove', generation))
    await rejects(s.complete(ticket, 'done'), 'conflict')
    console.log('PASS checkpoint payload identity, first timing, staging, and completion receipts')
  }

  {
    const f = fixture()
    const s = f.db.client()
    const outcomes = await Promise.all(['a', 'b'].map((id) => Effect.runPromise(Effect.result(
      s.claim(id, 0, { kind: 'strict' }, 3),
    ))))
    assert.equal(outcomes.filter(Result.isSuccess).length, 1)
    assert.equal(f.db.history().length, 1)
    const ticket = outcomes.find(Result.isSuccess)!.success
    f.db.advance(LEASE)
    await rejects(s.checkpoint(ticket, 'expired-stage', { kind: 'stage', tokens: initialTokens() }), 'conflict')
    const revision = f.db.snapshot().revision
    const transfers = await Promise.all(['c', 'd'].map((id) => Effect.runPromise(Effect.result(
      s.claim(id, revision, { kind: 'strict' }, 3),
    ))))
    assert.equal(transfers.filter(Result.isSuccess).length, 1)
    assert.equal(f.db.history().length, 1)
    console.log('PASS competing acquisitions/transfers have one winner; expiry alone rejects late writes')
  }
  for (const action of ['remove', 'replace'] as const) {
    const f = fixture()
    const paused = await f.pause('response')
    const previous = f.db.snapshot().operation!
    const ticket = { operation: previous.id, generation: previous.generation, fence: previous.owner!.fence }
    if (action === 'remove') {
      await f.run((m) => m.remove())
      await rejects(f.db.client().checkpoint(ticket, 'late-response', { kind: 'stage', tokens: initialTokens() }), 'conflict')
      await paused.resumeStale()
      assert.equal(f.db.snapshot().tokens, null)
    } else {
      const attempt = await f.run((m) => m.startAuthorization('session', 'replace'))
      await rejects(f.db.client().consume(`direct-${++directRequests}`, attempt.id, 'session'), 'busy')
      assert.equal(f.provider.exchanges, 0)
      assert.deepEqual(f.db.snapshot().operation, previous)
      await paused.resume()
      await f.run((m) => m.completeAuthorization(attempt.id, 'session'))
      assert.equal(f.db.history()[0]?.done, true)
      assert.equal(f.provider.exchanges, 1)
    }
    console.log(`PASS ${action}: removal fences refresh; preparation preserves it and callback waits for completion`)
  }

  for (const point of ['authorization-reserved', 'authorization-response'] as const) {
    const f = fixture({ kind: 'strict' }, false)
    const attempt = await f.run((m) => m.startAuthorization('session'))
    const paused = await f.pause(point, { id: attempt.id, binding: 'session' })
    await f.run((m) => m.remove())
    await paused.resumeStale()
    await credentialsFail(f, 'missing')
    assert.equal(f.provider.exchanges, point === 'authorization-reserved' ? 0 : 1)
    console.log(`PASS removal fences callback at ${point}`)
  }
  for (const action of ['remove', 'replace'] as const) {
    const f = fixture({ kind: 'strict' }, false)
    const stale = await f.run((m) => m.startAuthorization('session'))
    if (action === 'remove') await f.run((m) => m.remove())
    else await f.run((m) => m.startAuthorization('session', 'replace'))
    const result = await f.run((m) => Effect.result(m.completeAuthorization(stale.id, 'session')))
    assert.ok(Result.isFailure(result) && result.failure.code === 'invalid-attempt')
    assert.equal(f.provider.exchanges, 0)
    console.log(`PASS unconsumed stale attempt after ${action} rejected before exchange`)
  }
  {
    const f = fixture()
    const before = f.db.snapshot()
    const failed = await f.run((m) => Effect.result(m.startAuthorization('session')))
    assert.ok(Result.isFailure(failed) && failed.failure.code === 'conflict')
    assert.deepEqual(f.db.snapshot(), before)
    f.db.loseNextAck('start')
    const attempt = await f.run((m) => m.startAuthorization('session', 'replace'))
    assert.equal(f.db.snapshot().tokens?.access, 'FAKE-access-0')
    const mismatch = await f.run((m) => Effect.result(m.completeAuthorization(attempt.id, 'wrong')))
    assert.ok(Result.isFailure(mismatch) && mismatch.failure.code === 'invalid-attempt')
    assert.equal(f.provider.exchanges, 0)
    f.db.loseNextAck('authorize')
    const replacement = await f.run((m) => m.completeAuthorization(attempt.id, 'session'))
    assert.equal(replacement.id, before.id)
    assert.equal(f.provider.exchanges, 1)
    const repeated = await f.run((m) => Effect.result(m.completeAuthorization(attempt.id, 'session')))
    assert.ok(Result.isFailure(repeated) && repeated.failure.code === 'invalid-attempt')
    assert.equal(f.provider.exchanges, 1)
    const state = f.db.snapshot()
    const mutations = f.db.mutations
    const inspection = await f.run((m) => m.inspect())
    assert.deepEqual(inspection, { id: before.id, saved: true, pendingAuthorization: false, unresolved: false, attention: false })
    assert.deepEqual(f.db.snapshot(), state)
    assert.equal(f.db.mutations, mutations)
    assert.equal(f.provider.calls, 0)
    assert.equal(f.provider.exchanges, 1)
    assert.ok(!JSON.stringify(inspection).includes('FAKE-'))
    // Read-only service requires no credential read, Provider, Worker, or mutation methods.
    assert.deepEqual(await Effect.runPromise(makeManager().inspect().pipe(
      Effect.provideService(InspectionStore, { inspect: f.db.client().inspect }),
    )), inspection)
    console.log('PASS explicit replacement preserves ID, no silent overwrite; binding/single use; non-secret read-only inspection')
  }
  {
    const f = fixture()
    const s = f.db.client()
    f.db.loseNextAck('remove')
    await rejects(s.remove('delete', 0), 'ack-lost')
    const attempt = await f.run((m) => m.startAuthorization('new-session'))
    await f.run((m) => m.completeAuthorization(attempt.id, 'new-session'))
    const before = f.db.snapshot()
    await direct(s.remove('delete', 0))
    assert.deepEqual(f.db.snapshot(), before, 'Retry of old deletion must not delete new enrollment')
    const stale = await f.run((m) => m.startAuthorization('session', 'replace'))
    f.db.advance(100)
    await rejects(s.consume(`direct-${++directRequests}`, stale.id, 'session'), 'invalid-attempt')
    console.log('PASS tombstones allow deliberate reenrollment; delayed removal retry is harmless; attempts expire')
  }
  {
    const f = fixture({ kind: 'conditional', window: 50 })
    const attempt = await f.run((m) => m.startAuthorization('session', 'replace'))
    await f.run((m) => m.completeAuthorization(attempt.id, 'session'))
    const replacement = f.db.snapshot().tokens!
    f.db.advance(1000)
    const credentials = await f.run((m) => m.credentials())
    assert.equal(Redacted.value(credentials.accessToken), 'FAKE-access-1')
    assert.notEqual(f.db.snapshot().tokens?.refresh, replacement.refresh)
    assert.equal(f.provider.calls, 1)
    assert.equal(f.provider.exchanges, 1)
    assert.equal(f.db.snapshot().id, 'workspace-crm')
    console.log('PASS replacement grant enters ordinary refresh lifecycle under the same connection ID')
  }
  for (const expiry of [false, true]) {
    const f = fixture({ kind: 'strict' }, true, { ...initialTokens(), expires: 1000 })
    const before = f.db.snapshot()
    const attempt = await f.run((m) => m.startAuthorization('session', 'replace'))
    assert.equal(f.db.snapshot().generation, before.generation)
    if (expiry) f.db.advance(100)
    const credentials = await f.run((m) => m.credentials())
    assert.equal(Redacted.value(credentials.accessToken), 'FAKE-access-0')
    assert.equal(f.provider.calls, 0)
    assert.equal(f.provider.exchanges, 0)
    assert.equal((await f.run((m) => m.inspect())).pendingAuthorization, !expiry)
    if (expiry) await rejects(f.db.client().consume(`direct-${++directRequests}`, attempt.id, 'session'), 'invalid-attempt')
    console.log(`PASS ${expiry ? 'expired' : 'abandoned live'} preparation keeps valid credentials usable without IO`)
  }
  for (const expiry of [false, true]) {
    const f = fixture()
    const attempt = await f.run((m) => m.startAuthorization('session', 'replace'))
    if (expiry) f.db.advance(100)
    await f.run((m) => m.credentials())
    assert.equal(f.provider.calls, 1)
    assert.equal(f.provider.exchanges, 0)
    assert.equal(f.db.snapshot().tokens?.access, 'FAKE-access-1')
    if (!expiry) await f.run((m) => m.completeAuthorization(attempt.id, 'session'))
    console.log(`PASS refresh during ${expiry ? 'expired' : 'live'} browser preparation`)
  }
  {
    const f = fixture()
    const s = f.db.client()
    const first = await direct(s.start('page', 'session', 'replace'))
    assert.deepEqual(await direct(s.start('page', 'session', 'replace')), first)
    await rejects(s.start('page', 'other', 'replace'), 'conflict')
    await rejects(s.start('page', 'session', 'enroll'), 'conflict')
    const attempts = await Promise.all(['two', 'three'].map((key) => direct(s.start(key, 'session', 'replace'))))
    await rejects(s.start('page', 'session', 'replace'), 'conflict')
    await rejects(s.consume(`direct-${++directRequests}`, first.id, 'session'), 'invalid-attempt')
    await rejects(s.consume(`direct-${++directRequests}`, attempts[0]!.id, 'session'), 'invalid-attempt')
    await f.run((m) => m.credentials())
    const current = attempts[1]!
    const results = await Promise.all([1, 2].map(() => f.run((m) => Effect.result(m.completeAuthorization(current.id, 'session')))))
    assert.equal(results.filter(Result.isSuccess).length, 1)
    assert.equal(f.provider.exchanges, 1)
    console.log('PASS competing pages supersede only preparation; start payload identity and concurrent callback single-use')
  }
  {
    const f = fixture()
    const s = f.db.client()
    const attempt = await direct(s.start('expired-page', 'session', 'replace'))
    f.db.advance(100)
    await rejects(s.start('expired-page', 'session', 'replace'), 'conflict')
    await rejects(s.consume(`direct-${++directRequests}`, attempt.id, 'session'), 'invalid-attempt')
    await f.run((m) => m.credentials())
    console.log('PASS expired start receipt cannot renew preparation; old connection still refreshes')
  }
  for (const point of ['claimed', 'reserved', 'response', 'staged'] as const) {
    const f = fixture()
    const paused = await f.pause(point)
    const attempt = await f.run((m) => m.startAuthorization('session', 'replace'))
    const evidence = f.db.snapshot().operation
    await rejects(f.db.client().consume(`direct-${++directRequests}`, attempt.id, 'session'), 'busy')
    await paused.stop()
    f.db.advance(LEASE)
    await rejects(f.db.client().consume(`direct-${++directRequests}`, attempt.id, 'session'), 'busy')
    assert.deepEqual(f.db.snapshot().operation, evidence)
    assert.equal(f.provider.exchanges, 0)
    if (point === 'claimed' || point === 'staged') {
      await f.run((m) => m.credentials())
      await f.run((m) => m.completeAuthorization(attempt.id, 'session'))
      assert.equal(f.provider.exchanges, 1)
    } else {
      await credentialsFail(f, 'attention')
      await rejects(f.db.client().consume(`direct-${++directRequests}`, attempt.id, 'session'), 'attention')
      const retained = f.db.snapshot().operation
      f.db.advance(100)
      await f.run((m) => m.startAuthorization('another', 'replace'))
      assert.deepEqual(f.db.snapshot().operation, retained)
      await credentialsFail(f, 'attention')
      assert.equal(f.provider.calls, point === 'reserved' ? 0 : 1)
    }
    console.log(`PASS callback vs unresolved refresh at ${point}: no overlap or history reset, only defensible recovery`)
  }
  for (const policy of [{ kind: 'reusable' }, { kind: 'conditional', window: 50 }] as const) {
    const f = fixture(policy)
    f.provider.loseResponses = 1
    await credentialsFail(f, 'unknown')
    const original = f.db.snapshot().operation!
    const attempt = await f.run((m) => m.startAuthorization('session', 'replace'))
    await rejects(f.db.client().consume(`direct-${++directRequests}`, attempt.id, 'session'), 'busy')
    assert.deepEqual(f.db.snapshot().operation, original)
    f.db.advance(LEASE)
    await f.run((m) => m.credentials())
    const recovered = f.db.snapshot().operation!
    assert.equal(recovered.id, original.id)
    assert.equal(recovered.firstSend, original.firstSend)
    assert.equal(recovered.sends, 2)
    assert.equal(recovered.maxSends, 3)
    await f.run((m) => m.completeAuthorization(attempt.id, 'session'))
    assert.deepEqual(f.db.history()[0], recovered)
    assert.equal(f.provider.calls, 2)
    assert.equal(f.provider.exchanges, 1)
    console.log(`PASS ${policy.kind}: preparation preserves unknown-refresh evidence and budget through recovery then replacement`)
  }
  for (const loss of ['authorization-reserved', 'authorization-response', 'unknown'] as const) {
    const f = fixture({ kind: 'strict' }, true, { ...initialTokens(), expires: 10_000 })
    const attempt = await f.run((m) => m.startAuthorization('session', 'replace'))
    if (loss === 'authorization-reserved' || loss === 'authorization-response') {
      const paused = await f.pause(loss, { id: attempt.id, binding: 'session' })
      await paused.stop()
    } else {
      f.provider.loseExchangeResponses = 1
      const result = await f.run((m) => Effect.result(m.completeAuthorization(attempt.id, 'session')))
      assert.ok(Result.isFailure(result))
      assert.equal(result.failure.code, 'unknown')
    }
    const marker = f.db.snapshot().authorizationExchange
    for (const advance of [0, 100, 1000]) {
      f.db.advance(advance)
      const active = advance === 0
      await credentialsFail(f, active ? 'busy' : 'attention')
      await rejects(f.db.client().consume(`direct-${++directRequests}`, attempt.id, 'session'), 'invalid-attempt')
      const next = await f.run((m) => Effect.result(m.startAuthorization('new', 'replace')))
      assert.ok(Result.isFailure(next) && next.failure.code === (active ? 'busy' : 'attention'))
      assert.equal(f.db.snapshot().authorizationExchange, marker)
      assert.equal((await f.run((m) => m.inspect())).unresolved, true)
      assert.equal((await f.run((m) => m.inspect())).attention, !active)
    }
    assert.equal(f.provider.calls, 0)
    assert.equal(f.provider.exchanges, loss === 'unknown' || loss === 'authorization-response' ? 1 : 0)
    console.log(`PASS ${loss}: possible exchange blocks unsafe use/replay/supersession; expiry never unlocks`)
  }
  {
    const f = fixture()
    const attempt = await f.run((m) => m.startAuthorization('session', 'replace'))
    const paused = await f.pause('authorization-response', { id: attempt.id, binding: 'session' })
    await credentialsFail(f, 'busy')
    const before = f.db.snapshot()
    const mutations = f.db.mutations
    assert.deepEqual(await f.run((m) => m.inspect()), {
      id: 'workspace-crm', saved: true, pendingAuthorization: false, unresolved: true, attention: false,
    })
    assert.deepEqual(f.db.snapshot(), before)
    assert.equal(f.db.mutations, mutations)
    const competing = await f.run((m) => Effect.result(m.startAuthorization('other', 'replace')))
    assert.ok(Result.isFailure(competing) && competing.failure.code === 'busy')
    await rejects(f.db.client().claim('racing-refresh', f.db.snapshot().revision, { kind: 'strict' }, 3), 'conflict')
    f.db.advance(100)
    await credentialsFail(f, 'attention')
    assert.equal((await f.run((m) => m.inspect())).attention, true)
    await paused.resume() // Known response can finish after browser expiry, without replay.
    assert.equal(f.db.snapshot().authorizationExchange, null)
    assert.equal(Redacted.value((await f.run((m) => m.credentials())).accessToken), 'FAKE-authorized-1')
    assert.equal(f.provider.exchanges, 1)
    console.log('PASS reserved exchange excludes refresh; known late callback response resolves uncertainty after expiry')
  }
  {
    const f = fixture({ kind: 'strict' }, false)
    const s = f.db.client()
    const page = await direct(s.start('page', 'session', 'enroll'))
    const reserved = await direct(s.consume(`direct-${++directRequests}`, page.id, 'session'))
    const tokens = await direct(f.provider.service().exchange())
    f.db.loseNextAck('authorize')
    await rejects(s.authorize(reserved, tokens), 'ack-lost')
    await direct(s.authorize(reserved, tokens))
    await rejects(s.authorize(reserved, initialTokens()), 'conflict')
    const second = await f.run((m) => m.startAuthorization('next', 'replace'))
    await f.run((m) => m.completeAuthorization(second.id, 'next'))
    await rejects(s.authorize(reserved, tokens), 'conflict')
    assert.equal(f.db.snapshot().tokens?.access, 'FAKE-authorized-2')
    console.log('PASS authorization save identity retries only persistence; later exchange fences old success receipt')
  }
  {
    const f = fixture({ kind: 'strict' }, false)
    const s = f.db.client()
    const page = await direct(s.start('page', 'session', 'enroll'))
    f.db.loseNextAck('consume')
    await rejects(s.consume('invocation', page.id, 'session'), 'ack-lost')
    const reserved = await direct(s.consume('invocation', page.id, 'session'))
    const before = f.db.snapshot()
    const mutations = f.db.mutations
    f.db.advance(1)
    assert.deepEqual(await direct(s.consume('invocation', page.id, 'session')), reserved)
    assert.equal(f.db.mutations, mutations)
    assert.equal(f.db.snapshot().authorizationUntil, before.authorizationUntil)
    await rejects(s.consume('invocation', page.id, 'changed-binding'), 'conflict')
    await rejects(s.consume('invocation', 'changed-attempt', 'session'), 'conflict')
    await rejects(s.consume('second-invocation', page.id, 'session'), 'invalid-attempt')
    await rejects(s.authorize({ ...reserved, intent: 'replace' }, initialTokens()), 'conflict')
    await rejects(s.authorize({ ...reserved, invocation: 'other' }, initialTokens()), 'conflict')
    f.db.advance(LEASE - 1)
    await rejects(s.consume('invocation', page.id, 'session'), 'conflict')
    await rejects(s.consume('second-invocation', page.id, 'session'), 'invalid-attempt')
    assert.equal(f.db.snapshot().authorizationUntil, reserved.until)
    await f.run((m) => m.remove())
    const next = await f.run((m) => m.startAuthorization('new'))
    await f.run((m) => m.completeAuthorization(next.id, 'new'))
    await rejects(s.consume('invocation', page.id, 'session'), 'conflict')
    await rejects(s.authorize(reserved, initialTokens()), 'conflict')
    assert.equal(f.provider.exchanges, 1)
    assert.equal(f.db.snapshot().tokens?.access, 'FAKE-authorized-1')
    console.log('PASS consume receipt binds immutable input/current owner; expiry and new generation never revive it')
  }
  {
    const f = fixture()
    const page = await f.run((m) => m.startAuthorization('session', 'replace'))
    const paused = await f.pause('authorization-reserved', { id: page.id, binding: 'session' })
    await credentialsFail(f, 'busy')
    f.db.advance(LEASE)
    await paused.resumeStale()
    await credentialsFail(f, 'attention')
    const replay = await f.run((m) => Effect.result(m.completeAuthorization(page.id, 'session')))
    assert.ok(Result.isFailure(replay) && replay.failure.code === 'invalid-attempt')
    assert.equal(f.provider.exchanges, 0)
    console.log('PASS callback admission expires before dispatch; neither old workflow nor browser replay can send')
  }
  console.log(`ALL LIFECYCLE CHECKS PASSED (${workers} fresh managers/runtimes; fake storage/provider; no process-kill proof).`)
}
const watchdog = setTimeout(() => { console.error('Lifecycle experiment hung'); process.exit(1) }, 10_000)
try { await run() } finally { clearTimeout(watchdog) }
