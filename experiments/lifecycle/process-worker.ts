// Internal child entrypoint: paths are supplied only by process-demo's owned mkdtemp.
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { Effect, Result, Redacted } from 'effect'
import { makeManager, Store, Provider, Worker, type Fault, type Ticket, type AuthorizationReservation } from './model'
import { ProcessStore } from './process-store'
import { initialTokens } from './fakes'

const [directory, mode, stop] = process.argv.slice(2)
assert.ok(directory && mode)
const adapter = new ProcessStore(directory)
const pause = (point: string): Effect.Effect<void, Fault> => point === stop
  ? Effect.andThen(Effect.sync(() => console.log(JSON.stringify({ checkpoint: point, pid: process.pid }))), Effect.never)
  : Effect.void
const run = <A>(effect: Effect.Effect<A, Fault>) => Effect.runPromise(effect)
const rejects = async <A>(effect: Effect.Effect<A, Fault>, code: Fault['code']) => {
  const result = await run(Effect.result(effect))
  assert.ok(Result.isFailure(result))
  assert.equal(result.failure.code, code)
}
try {
  const s = adapter.client()
  if (mode === 'credentials') {
    let request = 0
    const invocation = randomUUID()
    const result = await Effect.runPromise(Effect.result(makeManager().credentials().pipe(
      Effect.provideService(Store, s),
      Effect.provideService(Provider, adapter.provider(() => pause('provider-committed'))),
      Effect.provideService(Worker, { request: () => `${invocation}/${++request}`, at: pause }),
    )))
    console.log(JSON.stringify(Result.isSuccess(result)
      ? { outcome: 'ok', access: Redacted.value(result.success.accessToken), pid: process.pid }
      : { outcome: result.failure.code, pid: process.pid }))
  } else if (mode === 'receipt-seed') {
    adapter.database((db) => db.loseNextAck('claim'))
    await rejects(s.claim('owner', 0, { kind: 'strict' }, 3), 'ack-lost')
    const ticket = await run(s.claim('owner', 0, { kind: 'strict' }, 3))
    await run(s.renew(ticket, 'renew'))
    await run(s.checkpoint(ticket, 'send', { kind: 'send', expectedSends: 0, notAfter: 10000 }))
    await run(s.checkpoint(ticket, 'stage', { kind: 'stage', tokens: initialTokens() }))
    await run(s.complete(ticket, 'done'))
    const page = await run(s.start('page', 'session', 'replace'))
    adapter.database((db) => db.loseNextAck('consume'))
    await rejects(s.consume('invocation', page.id, 'session'), 'ack-lost')
    const reservation = await run(s.consume('invocation', page.id, 'session'))
    // Persist test inputs, not an alternate workflow. New process tests stale receipt behavior.
    writeFileSync(`${directory}/evidence.json`, JSON.stringify({ ticket, reservation }))
    await Effect.runPromise(pause('receipt-seeded'))
  } else if (mode === 'receipt-check') {
    const { ticket, reservation } = JSON.parse(readFileSync(`${directory}/evidence.json`, 'utf8')) as {
      ticket: Ticket; reservation: AuthorizationReservation
    }
    assert.equal((await run(s.read())).authorizationExchange, reservation.id)
    assert.deepEqual(await run(s.consume('invocation', reservation.id, 'session')), reservation)
    await rejects(s.consume('invocation', reservation.id, 'changed'), 'conflict')
    await rejects(s.consume('different', reservation.id, 'session'), 'invalid-attempt')
    await rejects(s.claim('owner', 0, { kind: 'strict' }, 3), 'conflict')
    await rejects(s.renew(ticket, 'renew'), 'conflict')
    await rejects(s.checkpoint(ticket, 'stage', { kind: 'stage', tokens: initialTokens() }), 'conflict')
    await rejects(s.complete(ticket, 'done'), 'conflict')
    await run(s.authorize(reservation, initialTokens()))
    await run(s.authorize(reservation, initialTokens()))
    await rejects(s.authorize(reservation, { ...initialTokens(), access: 'FAKE-changed' }), 'conflict')
    const generation = (await run(s.read())).generation
    adapter.database((db) => db.loseNextAck('remove'))
    await rejects(s.remove('delete', generation), 'ack-lost')
    const page = await run(s.start('new-page', 'new-session', 'enroll'))
    assert.notEqual(page.id, reservation.id)
    const next = await run(s.consume('new-invocation', page.id, 'new-session'))
    await run(s.authorize(next, { ...initialTokens(), access: 'FAKE-new' }))
    const before = await run(s.read())
    await run(s.remove('delete', generation))
    assert.deepEqual(await run(s.read()), before)
    await rejects(s.remove('delete', generation + 1), 'conflict')
    await rejects(s.consume('invocation', reservation.id, 'session'), 'conflict')
    await rejects(s.authorize(reservation, initialTokens()), 'conflict')
    await rejects(s.start('page', 'session', 'replace'), 'conflict')
    await rejects(s.complete(ticket, 'done'), 'conflict')
    assert.equal(adapter.database((db) => db.history()).length, 1)
    assert.equal(before.generation, 3)
    assert.equal(before.tokens?.access, 'FAKE-new')
    console.log(JSON.stringify({ outcome: 'receipts-ok', generation: before.generation, pid: process.pid }))
  } else throw new Error(`Unknown internal mode: ${mode}`)
} finally { adapter.close() }
