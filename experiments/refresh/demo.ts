// THROWAWAY EXPERIMENT. Run: bun experiments/refresh/demo.ts
// Fake secrets only; no external calls or real persistence.
import assert from 'node:assert/strict'
import { Cause, Clock, Effect, Exit, Layer, ManagedRuntime, Redacted, Result } from 'effect'
import { DAY, makeFixture } from './fakes'
import type { FixtureOptions } from './fakes'
import {
  CommitConflict,
  makeManager,
  mergeRefreshResponse,
  Provider,
  ProviderRejected,
  RefreshPending,
  RefreshUncertain,
  Store,
} from './model'

const success = <A, E>(result: Result.Result<A, E>): A => {
  assert.ok(Result.isSuccess(result), 'Expected success')
  return result.success
}
const failure = <A, E>(result: Result.Result<A, E>): E => {
  assert.ok(Result.isFailure(result), 'Expected a typed failure')
  return result.failure
}

async function withFixture(
  options: FixtureOptions,
  run: (harness: {
    fixture: Effect.Success<ReturnType<typeof makeFixture>>
    a: ReturnType<typeof makeManager>
    b: ReturnType<typeof makeManager>
    runtimeA: ManagedRuntime.ManagedRuntime<Store | Provider, never>
    runtimeB: ManagedRuntime.ManagedRuntime<Store | Provider, never>
  }) => Promise<void>,
) {
  const fixture = await Effect.runPromise(makeFixture(options))
  // Separate manager objects AND runtimes. No shared local lock or token cache.
  const a = makeManager()
  const b = makeManager()
  const runtimeFor = (name: string) => ManagedRuntime.make(Layer.mergeAll(
    Layer.succeed(Store, fixture.client(name)),
    Layer.succeed(Provider, fixture.provider),
    Layer.succeed(Clock.Clock, fixture.clock),
  ))
  const runtimeA = runtimeFor('A')
  const runtimeB = runtimeFor('B')
  try {
    await run({ fixture, a, b, runtimeA, runtimeB })
  } finally {
    await Promise.all([runtimeA.dispose(), runtimeB.dispose()])
    assert.equal(fixture.stats.activeWaiters, 0, 'Interrupted waiters must release their resources')
  }
}

const awaitGate = (gate: Effect.Effect<void>) => Effect.runPromise(
  gate.pipe(Effect.timeout('2 seconds')),
)

async function run() {
  // Negative control: both readers obtain the old token and independently refresh.
  // No save is needed to expose the remote single-use-token race.
  await withFixture({ synchronizeReaders: true }, async ({ fixture, runtimeA, runtimeB }) => {
    const uncoordinated = Effect.gen(function* () {
      const record = yield* (yield* Store).read()
      return yield* (yield* Provider).refresh(record.tokens.refreshToken)
    })
    const results = await Promise.all([
      runtimeA.runPromise(Effect.result(uncoordinated)),
      runtimeB.runPromise(Effect.result(uncoordinated)),
    ])
    assert.equal(results.filter(Result.isSuccess).length, 1)
    const rejected = results.find(Result.isFailure)
    assert.ok(rejected && rejected.failure instanceof ProviderRejected)
    assert.equal(fixture.stats.providerCalls, 2)
    console.log('CONTROL: without a storage claim, two refreshes race and one is rejected.')
  })

  await withFixture({ synchronizeReaders: true, pauseAfterRotation: true }, async ({
    fixture, a, b, runtimeA, runtimeB,
  }) => {
    const batch = (manager: ReturnType<typeof makeManager>) => Effect.all(
      Array.from({ length: 4 }, () => manager.credentials()),
      { concurrency: 'unbounded' },
    )
    const first = runtimeA.runPromise(Effect.result(batch(a)))
    const second = runtimeB.runPromise(Effect.result(batch(b)))
    await awaitGate(fixture.exchanged)
    await awaitGate(fixture.clientBWaiting)
    assert.equal(fixture.snapshot().kind, 'refreshing')
    assert.equal(fixture.stats.providerCalls, 1)
    assert.equal(fixture.stats.claims, 1)
    assert.ok(fixture.stats.lostClaims >= 1, 'The fixture must actually exercise competing claims')
    await Effect.runPromise(fixture.releaseResponse)
    const credentials = [...success(await first), ...success(await second)]
    assert.equal(credentials.length, 8)
    for (const credential of credentials) {
      assert.equal(Redacted.value(credential.accessToken), 'FAKE-access-1')
      assert.equal('refreshToken' in credential, false)
      assert.ok(!JSON.stringify(credential).includes('FAKE-access-1'))
    }
    assert.equal(fixture.stats.providerCalls, 1)
    assert.equal(fixture.stats.commits, 1)
    assert.equal(fixture.snapshot().version, 2)
    await runtimeB.runPromise(b.credentials())
    assert.equal(fixture.stats.providerCalls, 1, 'Fresh credentials must not refresh again')

    // Advance the shared wall clock, not real time. Next refresh must use rotation.
    fixture.advanceTime()
    const next = await runtimeB.runPromise(b.credentials())
    assert.equal(Redacted.value(next.accessToken), 'FAKE-access-2')
    assert.deepEqual(fixture.submitted.map(Redacted.value), ['FAKE-refresh-0', 'FAKE-refresh-1'])
    assert.equal(Redacted.value(fixture.snapshot().tokens.refreshToken), 'FAKE-refresh-2')

    // An old writer cannot overwrite the later generation.
    const oldWrite = fixture.writes[0]
    assert.ok(oldWrite)
    const stale = await Effect.runPromise(Effect.result(
      fixture.client('stale').commit(1, oldWrite.operation, oldWrite.tokens),
    ))
    assert.ok(failure(stale) instanceof CommitConflict)
    assert.equal(fixture.snapshot().version, 4)
    assert.equal(Redacted.value(fixture.snapshot().tokens.accessToken), 'FAKE-access-2')
    console.log('PASS: 8 calls / 2 runtimes → 1 refresh; rotation reused; stale write rejected.')
  })

  for (const failWrites of ['once-before', 'once-after'] as const) {
    await withFixture({ failWrites, pauseAfterRotation: true }, async ({ fixture, a, b, runtimeA, runtimeB }) => {
      const leader = runtimeA.runPromise(Effect.result(a.credentials()))
      await awaitGate(fixture.exchanged)
      const follower = runtimeB.runPromise(Effect.result(b.credentials()))
      await awaitGate(fixture.clientBWaiting)
      await Effect.runPromise(fixture.releaseResponse)
      const credential = success(await leader)
      assert.equal(Redacted.value(success(await follower).accessToken), 'FAKE-access-1')
      assert.equal(fixture.stats.activeWaiters, 0)
      assert.equal(Redacted.value(credential.accessToken), 'FAKE-access-1')
      assert.equal(fixture.stats.providerCalls, 1)
      assert.equal(fixture.stats.commitCalls, 2)
      assert.equal(fixture.stats.commits, 1)
      assert.equal(new Set(fixture.writes.map((write) => write.operation)).size, 1)
      assert.ok(fixture.writes.every((write) => write.tokens === fixture.writes[0]?.tokens))
      await runtimeB.runPromise(b.credentials())
      assert.equal(fixture.stats.providerCalls, 1)
      console.log(`PASS: ${failWrites} write failure → retry the same save, not the provider exchange.`)
    })
  }

  for (const scenario of ['lost-write', 'lost-response'] as const) {
    const options: FixtureOptions = scenario === 'lost-write'
      ? { failWrites: 'always-before', pauseAfterRotation: true }
      : { loseProviderResponse: true, pauseAfterRotation: true }
    await withFixture(options, async ({ fixture, a, b, runtimeA, runtimeB }) => {
      const leader = runtimeA.runPromise(Effect.result(a.credentials()))
      await awaitGate(fixture.exchanged)
      const follower = runtimeB.runPromise(Effect.result(b.credentials()))
      await awaitGate(fixture.clientBWaiting)
      await Effect.runPromise(fixture.releaseResponse)
      const error = failure(await leader)
      assert.ok(error instanceof RefreshUncertain)
      assert.equal(error.stage, scenario === 'lost-write' ? 'persistence' : 'exchange')
      assert.equal(error.cause._tag, scenario === 'lost-write' ? 'StoreWriteFailed' : 'ProviderOutcomeUnknown')
      assert.equal(fixture.stats.commitCalls, scenario === 'lost-write' ? 3 : 0)
      assert.equal(fixture.stats.commits, 0)
      assert.equal(fixture.remoteGeneration(), 1)
      assert.equal(fixture.snapshot().kind, 'refreshing')
      assert.equal(Redacted.value(fixture.snapshot().tokens.refreshToken), 'FAKE-refresh-0')
      // An already-waiting manager must NOT reuse the now-invalid refresh token.
      const blocked = failure(await follower)
      assert.ok(blocked instanceof RefreshPending)
      assert.equal(fixture.stats.activeWaiters, 0)
      // Nor may a later call take over merely because the earlier wait timed out.
      assert.ok(failure(await runtimeB.runPromise(Effect.result(b.credentials()))) instanceof RefreshPending)
      assert.equal(fixture.stats.providerCalls, 1)
      console.log(`PASS: ${scenario} → typed uncertainty; waiting and later callers do not refresh.`)
    })
  }

  await withFixture({ pauseAfterRotation: true }, async ({ fixture, a, b, runtimeA, runtimeB }) => {
    const controller = new AbortController()
    const interrupted = runtimeA.runPromiseExit(a.credentials(), { signal: controller.signal })
    await awaitGate(fixture.exchanged)
    const follower = runtimeB.runPromise(Effect.result(b.credentials()))
    await awaitGate(fixture.clientBWaiting)
    controller.abort()
    const exit = await interrupted
    assert.ok(Exit.isFailure(exit) && Cause.hasInterrupts(exit.cause))
    assert.equal(fixture.remoteGeneration(), 1)
    assert.equal(fixture.stats.commitCalls, 0)
    assert.equal(fixture.snapshot().kind, 'refreshing')
    const blocked = failure(await follower)
    assert.ok(blocked instanceof RefreshPending)
    assert.equal(fixture.stats.activeWaiters, 0)
    assert.equal(fixture.stats.providerCalls, 1)
    console.log('PASS: interruption after remote rotation preserves the claim; no unsafe takeover.')
  })
  await withFixture({ pauseAfterRotation: true }, async ({ fixture, a, b, runtimeA, runtimeB }) => {
    const leader = runtimeA.runPromise(Effect.result(a.credentials()))
    await awaitGate(fixture.exchanged)
    const controller = new AbortController()
    const follower = runtimeB.runPromiseExit(b.credentials(), { signal: controller.signal })
    await awaitGate(fixture.clientBWaiting)
    assert.equal(fixture.stats.activeWaiters, 1)
    controller.abort()
    const exit = await follower
    assert.ok(Exit.isFailure(exit) && Cause.hasInterrupts(exit.cause))
    assert.equal(fixture.stats.activeWaiters, 0, 'Follower cancellation cleans up before runtime disposal')
    assert.equal(fixture.snapshot().kind, 'refreshing')
    await Effect.runPromise(fixture.releaseResponse)
    success(await leader)
    await runtimeB.runPromise(b.credentials())
    assert.equal(fixture.stats.providerCalls, 1)
    assert.equal(fixture.stats.commits, 1)
    console.log('PASS: cancelling a waiting caller releases its wait without cancelling the leader.')
  })

  await withFixture({}, async ({ fixture }) => {
    const store = fixture.client('contract-check')
    const initial = fixture.snapshot()
    assert.equal(await Effect.runPromise(store.claim(initial.version, 'owner')), true)
    const response = await Effect.runPromise(fixture.provider.refresh(initial.tokens.refreshToken))
    const tokens = mergeRefreshResponse(initial.tokens, response)
    for (const [version, operation] of [[1, 'wrong-owner'], [0, 'owner']] as const) {
      assert.ok(failure(await Effect.runPromise(Effect.result(
        store.commit(version, operation, tokens),
      ))) instanceof CommitConflict)
    }
    assert.equal(fixture.stats.commits, 0)
    await Effect.runPromise(store.commit(1, 'owner', tokens))
    await awaitGate(store.awaitChange(1)) // Commit preceded subscription: no missed wakeup.
    assert.equal(await Effect.runPromise(store.claim(0, 'stale-owner')), false)
    assert.equal(fixture.stats.commits, 1)
    console.log('PASS: commit checks both ownership and version; wait rechecks an already-changed version.')
  })

  await withFixture({ rejectRefresh: true }, async ({ fixture, a, runtimeA }) => {
    const error = failure(await runtimeA.runPromise(Effect.result(a.credentials())))
    assert.ok(error instanceof ProviderRejected, 'Known rejection must not become an unknown outcome')
    assert.equal(fixture.remoteGeneration(), 0)
    assert.equal(fixture.stats.providerCalls, 1)
    assert.equal(fixture.stats.commitCalls, 0)
    // The production rejected-authorization state transition is NOT implemented.
    assert.equal(fixture.snapshot().kind, 'refreshing')
    console.log('PASS: known provider rejection stays distinct from an unknown exchange outcome.')
  })
  // Recovery under an active claim: same library workflow, different provider facts.
  for (const profile of ['reusable', 'conditional'] as const) {
    await withFixture({ profile, lostResponses: 1, pauseAfterRotation: true, failWrites: 'once-before', initialRefreshLifetimeMillis: DAY }, async ({
      fixture, a, b, runtimeA, runtimeB,
    }) => {
      const original = fixture.snapshot().tokens.refreshToken
      const originalExpiry = fixture.snapshot().tokens.refreshTokenExpiresAt
      const leader = runtimeA.runPromise(Effect.result(a.credentials()))
      await awaitGate(fixture.exchanged)
      const follower = runtimeB.runPromise(Effect.result(b.credentials()))
      await awaitGate(fixture.clientBWaiting)
      await Effect.runPromise(fixture.releaseResponse)
      assert.equal(Redacted.value(success(await leader).accessToken), 'FAKE-access-2')
      assert.equal(Redacted.value(success(await follower).accessToken), 'FAKE-access-2')
      assert.equal(fixture.stats.claims, 1)
      assert.equal(fixture.stats.providerCalls, 2)
      assert.equal(fixture.stats.commitCalls, 2)
      assert.equal(fixture.stats.commits, 1)
      assert.equal(fixture.stats.activeWaiters, 0)
      assert.deepEqual(fixture.submitted.map(Redacted.value), ['FAKE-refresh-0', 'FAKE-refresh-0'])
      const saved = fixture.snapshot().tokens
      assert.equal(Redacted.value(saved.refreshToken), profile === 'reusable' ? 'FAKE-refresh-0' : 'FAKE-refresh-2')
      if (profile === 'reusable') assert.equal(saved.refreshTokenExpiresAt, originalExpiry)
      // A save failure after receiving response #2 must not trigger exchange #3.
      assert.ok(fixture.writes.every((write) => write.tokens === fixture.writes[0]?.tokens))
      fixture.advanceTime()
      await runtimeB.runPromise(b.credentials())
      assert.equal(Redacted.value(fixture.submitted[2]), Redacted.value(saved.refreshToken))
      assert.equal(fixture.stats.providerCalls, 3)
      if (profile === 'conditional') {
        assert.equal(fixture.tokenIsRetired(original), true, 'Using the replacement retires its predecessor')
        assert.ok(failure(await Effect.runPromise(Effect.result(
          fixture.provider.refresh(original),
        ))) instanceof ProviderRejected)
      }
      console.log(`PASS: ${profile} → recover lost response, retain actual result, retry only its save, unblock follower.`)
    })

    await withFixture({ profile, loseProviderResponse: true }, async ({ fixture, a, runtimeA }) => {
      assert.ok(failure(await runtimeA.runPromise(Effect.result(a.credentials()))) instanceof RefreshUncertain)
      assert.equal(fixture.stats.providerCalls, 3, 'Recovery must have a bounded exchange budget')
      assert.equal(fixture.stats.commitCalls, 0)
      console.log(`PASS: ${profile} → repeated response loss stops at three attempts.`)
    })

    await withFixture({ profile, failWrites: 'always-before' }, async ({ fixture, a, runtimeA }) => {
      const error = failure(await runtimeA.runPromise(Effect.result(a.credentials())))
      assert.ok(error instanceof RefreshUncertain && error.stage === 'persistence')
      assert.equal(fixture.stats.providerCalls, 1, 'Replay permission does not justify repeating a known successful exchange')
      assert.equal(fixture.stats.commitCalls, 3)
    })

    await withFixture({ profile, lostResponses: 1, pauseAfterRotation: true }, async ({ fixture, a, runtimeA }) => {
      const leader = runtimeA.runPromise(Effect.result(a.credentials()))
      await awaitGate(fixture.exchanged)
      // Simulate external replacement/revocation unknown to the manager.
      fixture.retireAllRefreshTokens()
      await Effect.runPromise(fixture.releaseResponse)
      assert.ok(failure(await leader) instanceof ProviderRejected)
      assert.equal(fixture.stats.providerCalls, 2)
      assert.equal(fixture.stats.providerRejections, 1)
      assert.equal(fixture.stats.commitCalls, 0)
      console.log(`PASS: ${profile} → a terminal rejection ends recovery; no third exchange.`)
    })
  }

  for (const changed of ['operation', 'version', 'state'] as const) {
    await withFixture({ profile: 'reusable', lostResponses: 1 }, async ({ fixture, a, runtimeA }) => {
      const backing = fixture.client('changed-observation')
      const store: Store['Service'] = {
        ...backing,
        read: () => Effect.map(backing.read(), (record) => {
          if (fixture.stats.providerCalls === 0 || record.kind !== 'refreshing') return record
          // Inject the observation that another operation changed ownership.
          // This tests the guard, NOT an implemented recovery/takeover protocol.
          if (changed === 'operation') return { ...record, operation: 'another-operation' }
          if (changed === 'version') return { ...record, version: record.version + 1 }
          return { kind: 'ready', version: record.version + 1, tokens: record.tokens, lastOperation: 'another-operation' }
        }),
      }
      const result = await runtimeA.runPromise(a.credentials().pipe(Effect.provideService(Store, store), Effect.result))
      assert.ok(failure(result) instanceof RefreshUncertain)
      assert.equal(fixture.stats.providerCalls, 1)
      assert.equal(fixture.stats.commitCalls, 0)
      console.log(`PASS: changed ${changed} observation prevents replay under obsolete ownership.`)
    })
  }

  await withFixture({ profile: 'reusable', lostResponses: 1, initialRefreshLifetimeMillis: DAY, advanceAfterLostResponseMillis: DAY }, async ({ fixture, a, runtimeA }) => {
    assert.ok(failure(await runtimeA.runPromise(Effect.result(a.credentials()))) instanceof RefreshUncertain)
    assert.equal(fixture.stats.providerCalls, 1)
    assert.equal(fixture.stats.providerRejections, 0)
    console.log('PASS: reusable-token recovery respects known expiry instead of assuming unlimited reuse.')
  })

  const conditionalCases: ReadonlyArray<{
    readonly name: string
    readonly options: FixtureOptions
    readonly succeeds: boolean
    readonly calls: number
  }> = [
    { name: 'beyond the obsolete one-hour window', options: { advanceAfterLostResponseMillis: 2 * 60 * 60 * 1_000 }, succeeds: true, calls: 2 },
    { name: 'at the thirty-day cap', options: { advanceAfterLostResponseMillis: 30 * DAY }, succeeds: false, calls: 1 },
    { name: 'at original expiry with one day remaining', options: { initialRefreshLifetimeMillis: DAY, advanceAfterLostResponseMillis: DAY }, succeeds: false, calls: 1 },
    { name: 'without expiry evidence', options: { omitInitialExpiryMetadata: true }, succeeds: false, calls: 1 },
    { name: 'without resetting the first-use clock on retry', options: { lostResponses: 2, advanceAfterLostResponseMillis: 16 * DAY }, succeeds: false, calls: 2 },
  ]
  for (const check of conditionalCases) {
    await withFixture({ profile: 'conditional', lostResponses: 1, ...check.options }, async ({ fixture, a, runtimeA }) => {
      const result = await runtimeA.runPromise(Effect.result(a.credentials()))
      if (check.succeeds) {
        assert.equal(Redacted.value(success(result).accessToken), 'FAKE-access-2')
      } else {
        assert.ok(failure(result) instanceof RefreshUncertain)
        assert.equal(fixture.stats.commitCalls, 0)
      }
      assert.equal(fixture.stats.providerCalls, check.calls)
      assert.equal(fixture.stats.providerRejections, 0, 'Known local limits prevent an inadmissible replay')
      console.log(`PASS: conditional recovery ${check.name} → ${check.succeeds ? 'recovered' : 'stopped'}.`)
    })
  }
  console.log('ALL REFRESH EXPERIMENT CHECKS PASSED (fake backend; no exactly-once claim).')
}

// Hard watchdog catches regressions that leave a gate or runtime hanging.
const watchdog = setTimeout(() => {
  console.error('Refresh experiment exceeded its 10-second watchdog.')
  process.exit(1)
}, 10_000)
try {
  await run()
} finally {
  clearTimeout(watchdog)
}
