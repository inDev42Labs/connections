// oxlint-disable vitest/no-conditional-expect -- Table branches assert mechanism-specific postconditions.
import { Effect, Exit, Redacted } from 'effect'
import { describe, expect, test } from 'vitest'
import { Connections } from '../../src/index.js'
import { makeDeterministicClientCredentialsProvider } from '../fixtures/client-credentials-provider.js'
import { makeInMemoryStore } from '../fixtures/in-memory-store.js'

function fixture() {
  const provider = makeDeterministicClientCredentialsProvider()
  const store = makeInMemoryStore()
  const connection = Connections.create({
    provider: provider.provider,
    store,
  }).effect
  const enroll = (source = 'old-source') =>
    Effect.runPromise(
      connection.setClientCredentials(
        'connection',
        { source: Redacted.make(source) },
        { replace: false },
      ),
    )
  const replace = (source = 'new-source') =>
    Effect.runPromise(
      connection.setClientCredentials(
        'connection',
        { source: Redacted.make(source) },
        { replace: true },
      ),
    )
  return { connection, enroll, provider, replace, store }
}

async function expectRemoved(connection: ReturnType<typeof fixture>['connection']) {
  await expect(
    Effect.runPromise(Effect.flip(connection.credentialUse('connection'))),
  ).resolves.toMatchObject({
    _tag: 'AuthorizationRequired',
  })
}

describe('client credentials replacement and removal fencing', () => {
  test('confirms removal after a lost acknowledgement without applying it twice', async () => {
    const value = fixture()
    await value.enroll()
    value.store.loseNextAcknowledgement('RemoveConnection')

    await Effect.runPromise(value.connection.remove('connection'))

    await expectRemoved(value.connection)
    expect(value.store.diagnostics.commands.RemoveConnection).toBe(2)
    expect(
      value.store.unsafeReadConnection({
        namespace: 'default',
        providerId: value.provider.provider.id,
        connectionId: 'connection',
      }),
    ).toMatchObject({ generation: 1, revision: 2 })
    expect(value.provider.requests()).toBe(0)
  })

  test('a removal receipt cannot report success over later enrollment', async () => {
    const value = fixture()
    await value.enroll()
    value.store.loseNextAcknowledgement('RemoveConnection')
    const acknowledgement = value.store.holdNext('RemoveConnection', 'after')
    const removal = Effect.runPromise(Effect.flip(value.connection.remove('connection')))
    try {
      await acknowledgement.reached
      await value.enroll('new-source')
    } finally {
      acknowledgement.release()
    }

    expect(await removal).toMatchObject({ _tag: 'RemovalFailure', reason: 'Conflict' })
    const current = await Effect.runPromise(value.connection.credentialUse('connection'))
    expect(Redacted.value(current.credentials.token)).toBe('token-1')
    expect(value.provider.acquiredSources()).toEqual(['new-source'])
    expect(value.store.diagnostics.commands.RemoveConnection).toBe(2)
  })

  test.each([
    ['replacement', async (value: ReturnType<typeof fixture>) => value.replace()],
    [
      'removal',
      async (value: ReturnType<typeof fixture>) =>
        Effect.runPromise(value.connection.remove('connection')),
    ],
  ] as const)('fences work owned before dispatch during %s', async (_transition, transition) => {
    const value = fixture()
    await value.enroll()
    const reservation = value.store.holdNext('ReserveCredentialOperationDispatch', 'before')
    const stale = Effect.runPromiseExit(value.connection.credentialUse('connection'))
    await reservation.reached

    await transition(value)
    reservation.release()
    const staleExit = await stale

    expect(Exit.isFailure(staleExit)).toBe(true)
    expect(value.provider.requests()).toBe(0)
    if (_transition === 'replacement') {
      value.provider.issue('new-token')
      const current = await Effect.runPromise(value.connection.credentialUse('connection'))
      expect(Redacted.value(current.credentials.token)).toBe('new-token')
      expect(value.provider.acquiredSources()).toEqual(['new-source'])
    } else {
      await expectRemoved(value.connection)
    }
  })

  test.each([
    ['replacement', async (value: ReturnType<typeof fixture>) => value.replace()],
    [
      'removal',
      async (value: ReturnType<typeof fixture>) =>
        Effect.runPromise(value.connection.remove('connection')),
    ],
  ] as const)(
    'fences dispatched provider completion during %s',
    async (_transition, transition) => {
      const value = fixture()
      await value.enroll()
      const providerCompletion = value.provider.pauseNextAcquisition()
      const stale = Effect.runPromiseExit(value.connection.credentialUse('connection'))
      await providerCompletion.reached

      await transition(value)
      providerCompletion.release()
      expect(Exit.isFailure(await stale)).toBe(true)

      if (_transition === 'replacement') {
        value.provider.issue('new-token')
        const current = await Effect.runPromise(value.connection.credentialUse('connection'))
        expect(Redacted.value(current.credentials.token)).toBe('new-token')
        expect(value.provider.acquiredSources()).toEqual(['old-source', 'new-source'])
      } else {
        await expectRemoved(value.connection)
      }
    },
  )

  test.each([
    [
      'ProviderFailure',
      'replacement',
      (value: ReturnType<typeof fixture>) => value.provider.failNext(),
      async (value: ReturnType<typeof fixture>) => value.replace(),
    ],
    [
      'ProviderFailure',
      'removal',
      (value: ReturnType<typeof fixture>) => value.provider.failNext(),
      async (value: ReturnType<typeof fixture>) =>
        Effect.runPromise(value.connection.remove('connection')),
    ],
    [
      'ProviderOutcomeUnknown',
      'replacement',
      (value: ReturnType<typeof fixture>) => value.provider.outcomeUnknownNext(),
      async (value: ReturnType<typeof fixture>) => value.replace(),
    ],
    [
      'ProviderOutcomeUnknown',
      'removal',
      (value: ReturnType<typeof fixture>) => value.provider.outcomeUnknownNext(),
      async (value: ReturnType<typeof fixture>) =>
        Effect.runPromise(value.connection.remove('connection')),
    ],
  ] as const)(
    '%s acquisition is fenced by local %s',
    async (_outcome, _transition, arrange, transition) => {
      const value = fixture()
      await value.enroll()
      arrange(value)
      await expect(
        Effect.runPromise(value.connection.credentialUse('connection')),
      ).rejects.toMatchObject({
        _tag: _outcome === 'ProviderFailure' ? 'TemporarilyUnavailable' : 'InterventionRequired',
      })
      expect(
        value.store.unsafeReadConnection({
          namespace: 'default',
          providerId: 'deterministic-client-credentials',
          connectionId: 'connection',
        })?.credentialOperation?.phase._tag,
      ).toBe(_outcome === 'ProviderFailure' ? 'KnownFailure' : 'InterventionRequired')

      await transition(value)
      expect(value.provider.requests()).toBe(1)
      if (_transition === 'replacement') {
        value.provider.issue('replacement-token')
        const current = await Effect.runPromise(value.connection.credentialUse('connection'))
        expect(Redacted.value(current.credentials.token)).toBe('replacement-token')
        expect(value.provider.acquiredSources()).toEqual(['old-source', 'new-source'])
      } else {
        await expectRemoved(value.connection)
      }
    },
  )

  test.each([
    ['replacement', async (value: ReturnType<typeof fixture>) => value.replace()],
    [
      'removal',
      async (value: ReturnType<typeof fixture>) =>
        Effect.runPromise(value.connection.remove('connection')),
    ],
  ] as const)(
    'fences completion acknowledgement delayed after persistence during %s',
    async (_transition, transition) => {
      const value = fixture()
      await value.enroll()
      const acknowledgement = value.store.holdNext('CompleteCredentialOperation', 'after')
      const stale = Effect.runPromiseExit(value.connection.credentialUse('connection'))
      await acknowledgement.reached

      await transition(value)
      acknowledgement.release()
      expect(Exit.isFailure(await stale)).toBe(true)

      if (_transition === 'replacement') {
        value.provider.issue('replacement-token')
        const current = await Effect.runPromise(value.connection.credentialUse('connection'))
        expect(Redacted.value(current.credentials.token)).toBe('replacement-token')
        expect(value.provider.acquiredSources()).toEqual(['old-source', 'new-source'])
      } else {
        await expectRemoved(value.connection)
      }
    },
  )

  test.each([
    ['replacement', async (value: ReturnType<typeof fixture>) => value.replace()],
    [
      'removal',
      async (value: ReturnType<typeof fixture>) =>
        Effect.runPromise(value.connection.remove('connection')),
    ],
  ] as const)('treats delayed rejection as stale during %s', async (_transition, transition) => {
    const value = fixture()
    await value.enroll()
    const issued = await Effect.runPromise(value.connection.credentialUse('connection'))
    const invalidation = value.store.holdNext('InvalidateCredential', 'before')
    const report = Effect.runPromise(issued.reportRejected())
    await invalidation.reached

    await transition(value)
    invalidation.release()
    await report

    if (_transition === 'replacement') {
      value.provider.issue('replacement-token')
      const current = await Effect.runPromise(value.connection.credentialUse('connection'))
      expect(Redacted.value(current.credentials.token)).toBe('replacement-token')
      expect(value.provider.requests()).toBe(2)
      expect(value.provider.acquiredSources()).toEqual(['old-source', 'new-source'])
    } else {
      await expectRemoved(value.connection)
    }
  })
})
