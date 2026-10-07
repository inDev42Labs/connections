import { Effect, Redacted } from 'effect'
import { describe, expect, test } from 'vitest'
import { Connections } from '../../src/index.js'
import { makeDeterministicClientCredentialsProvider } from '../fixtures/client-credentials-provider.js'
import { makeInMemoryStore } from '../fixtures/in-memory-store.js'
import { makeTestClock } from '../fixtures/lifecycle-driver.js'

function connectionFor(
  provider: ReturnType<typeof makeDeterministicClientCredentialsProvider>['provider'],
) {
  return Connections.create({
    provider,
    store: makeInMemoryStore(),
  }).effect
}

describe('client credentials lifecycle', () => {
  test('renews at the provider-reported expiry boundary', async () => {
    const clock = makeTestClock(1_000)
    const fixture = makeDeterministicClientCredentialsProvider()
    fixture.issue('token-1', 2_000)
    const connection = connectionFor(fixture.provider)
    const program = Effect.gen(function* () {
      yield* clock.initialize
      yield* connection.setClientCredentials(
        'connection',
        { source: Redacted.make('source') },
        { replace: false },
      )
      yield* connection.credentialUse('connection')
      yield* clock.advanceBy(999)
      yield* connection.credentialUse('connection')
      fixture.issue('token-2', 3_000)
      yield* clock.advanceBy(1)
      return yield* connection.credentialUse('connection')
    })

    const renewed = await Effect.runPromise(Effect.provide(program, clock.layer))
    expect(Redacted.value(renewed.credentials.token)).toBe('token-2')
    expect(fixture.requests()).toBe(2)
  })

  test('fails once when a provider returns an already expired credential', async () => {
    const clock = makeTestClock(1_000)
    const fixture = makeDeterministicClientCredentialsProvider()
    fixture.issue('expired-token', 999)
    const connection = connectionFor(fixture.provider)
    const program = Effect.gen(function* () {
      yield* clock.initialize
      yield* connection.setClientCredentials(
        'connection',
        { source: Redacted.make('source') },
        { replace: false },
      )
      return yield* Effect.flip(connection.credentialUse('connection'))
    })

    const failure = await Effect.runPromise(Effect.provide(program, clock.layer))
    expect(failure).toMatchObject({
      _tag: 'TemporarilyUnavailable',
      cause: { _tag: 'ProviderFailure' },
    })
    expect(fixture.requests()).toBe(1)
  })

  test('reuses credentials without provider-reported expiry until rejection', async () => {
    const clock = makeTestClock(1_000)
    const fixture = makeDeterministicClientCredentialsProvider()
    const connection = connectionFor(fixture.provider)
    const program = Effect.gen(function* () {
      yield* clock.initialize
      yield* connection.setClientCredentials('connection', { source: Redacted.make('source') })
      yield* connection.credentials('connection')
      yield* clock.advanceBy(31_536_000_000)
      return yield* connection.credentials('connection')
    })

    const reused = await Effect.runPromise(Effect.provide(program, clock.layer))
    expect(Redacted.value(reused.token)).toBe('token-1')
    expect(fixture.requests()).toBe(1)
  })

  test('coordinates concurrent first callers behind one provider dispatch', async () => {
    const fixture = makeDeterministicClientCredentialsProvider()
    const connection = connectionFor(fixture.provider)
    const checkpoint = fixture.pauseNextAcquisition()
    await Effect.runPromise(
      connection.setClientCredentials(
        'connection',
        { source: Redacted.make('source') },
        { replace: false },
      ),
    )
    const callers = Effect.runPromise(
      Effect.all([connection.credentialUse('connection'), connection.credentialUse('connection')], {
        concurrency: 'unbounded',
      }),
    )
    await checkpoint.reached
    expect(fixture.requests()).toBe(1)
    checkpoint.release()
    const issued = await callers
    expect(issued.map((credential) => Redacted.value(credential.credentials.token))).toEqual([
      'token-1',
      'token-1',
    ])
    expect(fixture.requests()).toBe(1)
  })

  test('gives repeated equal token bytes distinct handles and ignores stale rejection reports', async () => {
    const fixture = makeDeterministicClientCredentialsProvider()
    const connection = connectionFor(fixture.provider)
    await Effect.runPromise(
      connection.setClientCredentials(
        'connection',
        { source: Redacted.make('source-secret') },
        { replace: false },
      ),
    )
    const first = await Effect.runPromise(connection.credentialUse('connection'))
    fixture.issue('token-1')
    await Effect.runPromise(first.reportRejected())
    const second = await Effect.runPromise(connection.credentialUse('connection'))

    expect(Redacted.value(second.credentials.token)).toBe('token-1')
    expect(fixture.requests()).toBe(2)

    await Effect.runPromise(first.reportRejected())
    await Effect.runPromise(connection.credentialUse('connection'))
    expect(fixture.requests()).toBe(2)
  })

  test('invalidates only the current handle and reacquires once for concurrent callers', async () => {
    const fixture = makeDeterministicClientCredentialsProvider()
    const connection = connectionFor(fixture.provider)
    await Effect.runPromise(
      connection.setClientCredentials(
        'connection',
        { source: Redacted.make('source') },
        { replace: false },
      ),
    )
    const first = await Effect.runPromise(connection.credentialUse('connection'))
    await Effect.runPromise(first.reportRejected())
    const checkpoint = fixture.pauseNextAcquisition()
    const callers = Effect.runPromise(
      Effect.all([connection.credentialUse('connection'), connection.credentialUse('connection')], {
        concurrency: 'unbounded',
      }),
    )
    await checkpoint.reached
    expect(fixture.requests()).toBe(2)
    checkpoint.release()
    const replacement = await callers

    expect(replacement.map((issued) => Redacted.value(issued.credentials.token))).toEqual([
      'token-1',
      'token-1',
    ])
    expect(fixture.requests()).toBe(2)
  })

  test('treats duplicate and delayed rejection reports as harmless no-ops', async () => {
    const fixture = makeDeterministicClientCredentialsProvider()
    const connection = connectionFor(fixture.provider)
    await Effect.runPromise(
      connection.setClientCredentials(
        'connection',
        { source: Redacted.make('source') },
        { replace: false },
      ),
    )
    const first = await Effect.runPromise(connection.credentialUse('connection'))
    await Effect.runPromise(first.reportRejected())
    await Effect.runPromise(first.reportRejected())
    fixture.issue('token-2')
    const second = await Effect.runPromise(connection.credentialUse('connection'))

    // A delayed 401 for the former lifecycle cannot invalidate the replacement.
    await Effect.runPromise(first.reportRejected())
    const current = await Effect.runPromise(connection.credentialUse('connection'))
    expect(Redacted.value(second.credentials.token)).toBe('token-2')
    expect(Redacted.value(current.credentials.token)).toBe('token-2')
    expect(fixture.requests()).toBe(2)
  })

  test('does not let a handle invalidate a different connection lifecycle', async () => {
    const fixture = makeDeterministicClientCredentialsProvider()
    const store = makeInMemoryStore()
    const manager = Connections.create({
      provider: fixture.provider,
      store,
    })
    const firstConnection = manager.effect
    const secondConnection = manager.effect
    await Effect.runPromise(
      Effect.all([
        firstConnection.setClientCredentials(
          'first',
          { source: Redacted.make('first-source') },
          { replace: false },
        ),
        secondConnection.setClientCredentials(
          'second',
          { source: Redacted.make('second-source') },
          { replace: false },
        ),
      ]),
    )
    const first = await Effect.runPromise(firstConnection.credentialUse('first'))
    const second = await Effect.runPromise(secondConnection.credentialUse('second'))

    await Effect.runPromise(first.reportRejected())
    const firstCurrent = await Effect.runPromise(firstConnection.credentialUse('first'))
    const secondCurrent = await Effect.runPromise(secondConnection.credentialUse('second'))

    expect(Redacted.value(firstCurrent.credentials.token)).toBe('token-1')
    expect(Redacted.value(second.credentials.token)).toBe('token-1')
    expect(Redacted.value(secondCurrent.credentials.token)).toBe('token-1')
    expect(fixture.requests()).toBe(3)
  })
})
