import { inspect } from 'node:util'
import { Effect } from 'effect'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { Connections, CredentialConfigurationFailure, revealSecret } from '../../src/index.js'
import { ApiKey } from '../../src/providers/api-key/index.js'
import { Memory } from '../../src/stores/memory/index.js'
import { Convex, type ConvexInvocationContext } from '../../src/stores/convex/index.js'
import { makeInMemoryStore, replaceSavedCredentialPayload } from '../fixtures/in-memory-store.js'

const encryptionKey = 'KioqKioqKioqKioqKioqKioqKioqKioqKioqKioqKio='
const promiseContext = {
  runQuery: () => Promise.reject(new Error('Static Memory workflow must not query Convex')),
  runMutation: () => Promise.reject(new Error('Static Memory workflow must not mutate Convex')),
} as ConvexInvocationContext

function fixture() {
  const store = makeInMemoryStore()
  const manager = Connections.create({ provider: ApiKey.opaque({ id: 'retell' }), store })
  return { manager, store }
}

afterEach(() => vi.unstubAllGlobals())

describe('API-key connection lifecycle', () => {
  test('enrolls, inspects, retrieves, and removes an opaque key without provider traffic', async () => {
    const fetch = vi.fn<(...args: Parameters<typeof globalThis.fetch>) => Promise<Response>>(() =>
      Promise.reject(new Error('Provider traffic is forbidden')),
    )
    vi.stubGlobal('fetch', fetch)
    const manager = Connections.create({
      provider: ApiKey.opaque({ id: 'retell' }),
      store: Memory.store({ encryptionKey }),
    })
    const apiKey = '  opaque.service/key+value  '

    await manager.setApiKey('conn_acme', apiKey)
    expect(await manager.inspect('conn_acme')).toEqual({
      savedAuthorization: true,
      credentialWork: 'idle',
    })
    const credentials = await manager.credentials('conn_acme')
    expect(revealSecret(credentials.apiKey)).toBe(apiKey)
    expect(Object.keys(credentials)).toEqual(['apiKey'])

    await manager.remove('conn_acme')
    await expect(manager.credentials('conn_acme')).rejects.toMatchObject({
      _tag: 'AuthorizationRequired',
    })
    expect(await manager.inspect('conn_acme')).toEqual({
      savedAuthorization: false,
      credentialWork: 'idle',
    })
    expect(fetch).not.toHaveBeenCalled()
  })

  test('does not return a rejected key and ignores old rejection reports after replacement', async () => {
    const { manager } = fixture()
    await manager.setApiKey('conn_acme', 'rejected-key')
    const rejected = await manager.credentialUse('conn_acme')
    await rejected.reportRejected()

    await expect(manager.credentials('conn_acme')).rejects.toMatchObject({
      _tag: 'AuthorizationRequired',
    })
    await manager.setApiKey('conn_acme', 'replacement-key', { replace: true })
    await rejected.reportRejected()
    expect(revealSecret((await manager.credentials('conn_acme')).apiKey)).toBe('replacement-key')
  })

  test('requires explicit enrollment and replacement intent while preserving opaque key bytes', async () => {
    const { manager } = fixture()
    const first = '  opaque first key  '
    const second = '__retell_replacement_key__'

    await expect(manager.setApiKey('conn_acme', first, { replace: true })).rejects.toMatchObject({
      _tag: 'CredentialConfigurationFailure',
      reason: 'Conflict',
    })
    await manager.setApiKey('conn_acme', first)
    await expect(manager.setApiKey('conn_acme', second)).rejects.toMatchObject({
      _tag: 'CredentialConfigurationFailure',
      reason: 'Conflict',
    })
    expect(revealSecret((await manager.credentials('conn_acme')).apiKey)).toBe(first)

    await manager.setApiKey('conn_acme', second, { replace: true })
    expect(revealSecret((await manager.credentials('conn_acme')).apiKey)).toBe(second)
  })

  test('keeps different provider identities independent in the same store', async () => {
    const store = Memory.store({ encryptionKey })
    const first = Connections.create({ store, provider: ApiKey.opaque({ id: 'retell' }) })
    const second = Connections.create({ store, provider: ApiKey.opaque({ id: 'other-provider' }) })
    await first.setApiKey('same-id', 'first-key')
    await second.setApiKey('same-id', 'second-key')

    const recreated = Connections.create({ store, provider: ApiKey.opaque({ id: 'retell' }) })
    expect(revealSecret((await recreated.credentials('same-id')).apiKey)).toBe('first-key')
    expect(revealSecret((await second.credentials('same-id')).apiKey)).toBe('second-key')
  })

  test('requires a nonempty provider identity', () => {
    expect(() => ApiKey.opaque({ id: '' })).toThrow(TypeError)
  })

  test('rejects an empty key without enrolling a connection or replacing a saved key', async () => {
    const { manager } = fixture()
    await expect(manager.setApiKey('conn_acme', '')).rejects.toMatchObject({
      _tag: 'CredentialConfigurationFailure',
      reason: 'InvalidApiKey',
    })
    expect(await manager.inspect('conn_acme')).toEqual({
      savedAuthorization: false,
      credentialWork: 'idle',
    })
    await manager.setApiKey('conn_acme', 'saved-key')
    await expect(manager.setApiKey('conn_acme', '', { replace: true })).rejects.toMatchObject({
      _tag: 'CredentialConfigurationFailure',
      reason: 'InvalidApiKey',
    })
    expect(revealSecret((await manager.credentials('conn_acme')).apiKey)).toBe('saved-key')
  })

  test('keeps a contaminated enrollment failure secret-safe and leaves authorization absent', async () => {
    const secret = '__retell_contaminated_configuration_key__'
    const manager = Connections.create({
      provider: {
        ...ApiKey.opaque({ id: 'retell' }),
        prepareApiKey: () =>
          Effect.fail(Object.assign(new Error(`Rejected ${secret}`), { secret })),
      },
      store: Memory.store({ encryptionKey }),
    })
    const failure = await manager.setApiKey('conn_acme', secret).catch((error: unknown) => error)

    expect(failure).toBeInstanceOf(CredentialConfigurationFailure)
    expect(failure).toMatchObject({ reason: 'InvalidApiKey' })
    expect([String(failure), JSON.stringify(failure), inspect(failure)].join('\n')).not.toContain(
      secret,
    )
    expect(await manager.inspect('conn_acme')).toEqual({
      savedAuthorization: false,
      credentialWork: 'idle',
    })
  })

  test('omits contaminated credential-read failures from public diagnostics', async () => {
    const secret = '__retell_projection_failure_secret__'
    const manager = Connections.create({
      provider: {
        ...ApiKey.opaque({ id: 'retell' }),
        projectCredentials: () => Effect.fail(new Error(`Malformed ${secret}`)),
      },
      store: Memory.store({ encryptionKey }),
    })
    await manager.setApiKey('conn_acme', 'stored-key')
    const failure = await manager.credentials('conn_acme').catch((error: unknown) => error)

    expect(failure).toMatchObject({
      _tag: 'TemporarilyUnavailable',
      cause: { _tag: 'ProviderFailure' },
    })
    expect([String(failure), JSON.stringify(failure), inspect(failure)].join('\n')).not.toContain(
      secret,
    )
  })

  test('stores keys encrypted and returns redacted credentials', async () => {
    const { manager, store } = fixture()
    const secret = '__retell_persisted_key_canary__'
    await manager.setApiKey('conn_acme', secret)
    const credentials = await manager.credentials('conn_acme')
    const persisted = store.unsafeReadConnection({
      namespace: 'default',
      providerId: 'retell',
      connectionId: 'conn_acme',
    })

    expect(persisted).not.toBeNull()
    expect(JSON.stringify(persisted)).not.toContain(secret)
    expect(
      [String(credentials), JSON.stringify(credentials), inspect(credentials)].join('\n'),
    ).not.toContain(secret)
    expect(revealSecret(credentials.apiKey)).toBe(secret)
  })

  test.each([
    ['an unsupported schema', JSON.stringify({ schemaVersion: 2, apiKey: '__malformed_secret__' })],
    ['an empty saved key', JSON.stringify({ schemaVersion: 1, apiKey: '' })],
    ['invalid JSON', '{__malformed_secret__'],
  ])('fails safely when decrypted credentials contain %s', async (_name, payload) => {
    const { manager, store } = fixture()
    await manager.setApiKey('conn_acme', 'stored-key')
    await replaceSavedCredentialPayload(
      store,
      { namespace: 'default', providerId: 'retell', connectionId: 'conn_acme' },
      payload,
    )

    const failure = await manager.credentials('conn_acme').catch((error: unknown) => error)
    expect(failure).toMatchObject({
      _tag: 'TemporarilyUnavailable',
      cause: { _tag: 'ProviderFailure' },
    })
    expect([String(failure), JSON.stringify(failure), inspect(failure)].join('\n')).not.toContain(
      '__malformed_secret__',
    )
  })

  test('returns the saved key after its committed enrollment acknowledgement is lost', async () => {
    const { manager, store } = fixture()
    store.loseNextAcknowledgement('SaveCredential')
    await manager.setApiKey('conn_acme', '__retell_committed_key__')

    expect(revealSecret((await manager.credentials('conn_acme')).apiKey)).toBe(
      '__retell_committed_key__',
    )
    await manager.setApiKey('conn_acme', 'replacement-key', { replace: true })
    expect(revealSecret((await manager.credentials('conn_acme')).apiKey)).toBe('replacement-key')
  })

  test.each([false, true])(
    'a delayed replacement cannot undo removal or later enrollment (reenroll: %s)',
    async (reenroll) => {
      const { manager, store } = fixture()
      await manager.setApiKey('conn_acme', '__retell_original_key__')
      const held = store.holdNext('SaveCredential', 'before')
      const delayedReplacement = manager
        .setApiKey('conn_acme', '__retell_stale_replacement_key__', { replace: true })
        .catch((error: unknown) => error)

      try {
        await held.reached
        await manager.remove('conn_acme')
        await expect(manager.credentials('conn_acme')).rejects.toMatchObject({
          _tag: 'AuthorizationRequired',
        })
        if (reenroll) await manager.setApiKey('conn_acme', 'reenrolled-key')
      } finally {
        held.release()
      }

      expect(await delayedReplacement).toMatchObject({
        _tag: 'CredentialConfigurationFailure',
        reason: 'Conflict',
      })
      const current = await manager.credentials('conn_acme').then(
        (credentials) => revealSecret(credentials.apiKey),
        (error: unknown) => error,
      )
      const absent = expect.objectContaining({ _tag: 'AuthorizationRequired' })
      expect(current).toEqual(reenroll ? 'reenrolled-key' : absent)
    },
  )

  test('composes enrollment, retrieval, and removal through the Effect interface', async () => {
    const { manager } = fixture()
    const connection = manager.effect
    await Convex.run(
      promiseContext,
      Effect.gen(function* () {
        yield* connection.setApiKey('conn_acme', '__retell_promise_key__')
        const use = yield* connection.credentialUse('conn_acme')
        expect(revealSecret(use.credentials.apiKey)).toBe('__retell_promise_key__')
        yield* connection.remove('conn_acme')
      }),
    )
    await expect(manager.credentials('conn_acme')).rejects.toMatchObject({
      _tag: 'AuthorizationRequired',
    })
  })
})
