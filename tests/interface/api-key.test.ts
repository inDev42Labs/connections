import { Buffer } from 'node:buffer'
import { inspect } from 'node:util'
import { Effect, Redacted } from 'effect'
import { afterEach, describe, expect, test, vi } from 'vitest'
import type { ApiKeyProviderDefinition } from '../../src/core/contracts/provider.js'
import { Connections, CredentialConfigurationFailure } from '../../src/index.js'
import { AesGcm } from '../../src/encryptors/aes-gcm/index.js'
import { ApiKey } from '../../src/providers/api-key/index.js'
import { Configuration } from '../../src/configuration/index.js'
import { Convex, type ConvexInvocationContext } from '../../src/stores/convex/index.js'
import { makeInMemoryStore } from '../fixtures/in-memory-store.js'

const encryptionKey = Buffer.from(new Uint8Array(32).fill(42)).toString('base64')
const promiseContext = {
  runQuery: () => Promise.reject(new Error('Static Memory workflow must not query Convex')),
  runMutation: () => Promise.reject(new Error('Static Memory workflow must not mutate Convex')),
} as ConvexInvocationContext

function fixture() {
  const store = makeInMemoryStore({
    encryptor: AesGcm.encryptor({
      key: Configuration.secret(() => encryptionKey),
      keyId: 'retell-api-key-test',
    }),
  })
  const manager = Connections.create({
    provider: ApiKey.opaque({ id: 'retell' }),
    store,
  })
  return { connection: manager.effect, manager, store }
}

function value(redacted: Redacted.Redacted<string>): string {
  return Redacted.value(redacted)
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('API-key connection lifecycle', () => {
  test('enrolls, inspects, retrieves, and removes an opaque key without browser or network work', async () => {
    const fetch = vi.fn<() => Promise<never>>(() =>
      Promise.reject(new Error('Retell traffic is forbidden')),
    )
    vi.stubGlobal('fetch', fetch)
    const configured = fixture()
    const apiKey = '__retell_static_api_key__'

    await Effect.runPromise(
      configured.connection.setApiKey('conn_acme', Redacted.value(Redacted.make(apiKey)), {
        replace: false,
      }),
    )
    const inspection = await Effect.runPromise(configured.connection.inspect('conn_acme'))
    const credentials = await Effect.runPromise(configured.connection.credentialUse('conn_acme'))
    const snapshot = configured.store.unsafeReadConnection({
      namespace: 'default',
      providerId: 'retell',
      connectionId: 'conn_acme',
    })

    expect(inspection).toEqual({ savedAuthorization: true, credentialWork: 'idle' })
    expect(value(credentials.credentials.apiKey)).toBe(apiKey)
    expect(Object.keys(credentials.credentials)).toEqual(['apiKey'])
    expect(snapshot).toMatchObject({
      generation: 0,
      revision: 1,
      authorization: { _tag: 'Authorized', credentialExpiresAt: null },
      credentialOperation: null,
    })
    expect(JSON.stringify(snapshot)).not.toContain(apiKey)
    expect(configured.store.diagnostics.commands.SaveCredential).toBe(1)
    expect(configured.store.diagnostics.commands.CreateAuthorizationAttempt).toBeUndefined()
    expect(configured.store.diagnostics.commands.AcquireCredentialOperation).toBeUndefined()
    expect(fetch).not.toHaveBeenCalled()

    await Effect.runPromise(configured.connection.remove('conn_acme'))

    await expect(
      Effect.runPromise(Effect.flip(configured.connection.credentialUse('conn_acme'))),
    ).resolves.toMatchObject({ _tag: 'AuthorizationRequired' })
    await expect(Effect.runPromise(configured.connection.inspect('conn_acme'))).resolves.toEqual({
      savedAuthorization: false,
      credentialWork: 'idle',
    })
    expect(fetch).not.toHaveBeenCalled()
  })

  test('does not return a rejected key and allows explicit replacement', async () => {
    const configured = fixture()
    await Effect.runPromise(
      configured.connection.setApiKey('conn_acme', 'rejected-key', { replace: false }),
    )
    const rejected = await Effect.runPromise(configured.connection.credentialUse('conn_acme'))
    await Effect.runPromise(rejected.reportRejected())

    await expect(
      Effect.runPromise(Effect.flip(configured.connection.credentialUse('conn_acme'))),
    ).resolves.toMatchObject({ _tag: 'AuthorizationRequired' })
    await Effect.runPromise(
      configured.connection.setApiKey('conn_acme', 'replacement-key', { replace: true }),
    )
    await Effect.runPromise(rejected.reportRejected())
    expect(
      value(
        (await Effect.runPromise(configured.connection.credentialUse('conn_acme'))).credentials
          .apiKey,
      ),
    ).toBe('replacement-key')
  })

  test('requires explicit enrollment and replacement intent while preserving opaque key bytes', async () => {
    const configured = fixture()
    const first = '  opaque first key  '
    const second = '__retell_replacement_key__'

    await expect(
      Effect.runPromise(
        Effect.flip(
          configured.connection.setApiKey('conn_acme', Redacted.value(Redacted.make(first)), {
            replace: true,
          }),
        ),
      ),
    ).resolves.toMatchObject({
      _tag: 'CredentialConfigurationFailure',
      reason: 'Conflict',
    })
    await Effect.runPromise(
      configured.connection.setApiKey('conn_acme', Redacted.value(Redacted.make(first)), {
        replace: false,
      }),
    )
    await expect(
      Effect.runPromise(
        Effect.flip(
          configured.connection.setApiKey('conn_acme', Redacted.value(Redacted.make(second)), {
            replace: false,
          }),
        ),
      ),
    ).resolves.toMatchObject({
      _tag: 'CredentialConfigurationFailure',
      reason: 'Conflict',
    })
    expect(
      value(
        (await Effect.runPromise(configured.connection.credentialUse('conn_acme'))).credentials
          .apiKey,
      ),
    ).toBe(first)

    await Effect.runPromise(
      configured.connection.setApiKey('conn_acme', Redacted.value(Redacted.make(second)), {
        replace: true,
      }),
    )

    expect(
      value(
        (await Effect.runPromise(configured.connection.credentialUse('conn_acme'))).credentials
          .apiKey,
      ),
    ).toBe(second)
    expect(
      configured.store.unsafeReadConnection({
        namespace: 'default',
        providerId: 'retell',
        connectionId: 'conn_acme',
      }),
    ).toMatchObject({ generation: 1, revision: 2 })
  })

  test('rejects an empty key through a secret-safe configuration failure', async () => {
    const secret = '__retell_contaminated_configuration_key__'
    const base = ApiKey.opaque({ id: 'retell' })
    const provider: ApiKeyProviderDefinition<{
      readonly apiKey: Redacted.Redacted<string>
    }> = {
      ...base,
      prepareApiKey: () => Effect.fail(Object.assign(new Error(`Rejected ${secret}`), { secret })),
    }
    const store = makeInMemoryStore()
    const manager = Connections.create({ provider, store })

    const contaminatedFailure = await Effect.runPromise(
      Effect.flip(
        manager.effect.setApiKey('conn_acme', Redacted.value(Redacted.make(secret)), {
          replace: false,
        }),
      ),
    )
    const emptyFailure = await Effect.runPromise(
      Effect.flip(fixture().connection.setApiKey('conn_acme', '', { replace: false })),
    )

    expect(contaminatedFailure).toBeInstanceOf(CredentialConfigurationFailure)
    expect(contaminatedFailure).toMatchObject({ reason: 'InvalidApiKey' })
    expect(
      [
        String(contaminatedFailure),
        JSON.stringify(contaminatedFailure),
        inspect(contaminatedFailure),
      ].join('\n'),
    ).not.toContain(secret)
    expect(emptyFailure).toMatchObject({
      _tag: 'CredentialConfigurationFailure',
      reason: 'InvalidApiKey',
    })
    expect(store.diagnostics.executions).toBe(0)
  })

  test('classifies a validly decrypted malformed provider payload as a provider failure', async () => {
    const secret = '__retell_projection_failure_secret__'
    const base = ApiKey.opaque({ id: 'retell' })
    let rejectProjection = false
    const provider: ApiKeyProviderDefinition<{
      readonly apiKey: Redacted.Redacted<string>
    }> = {
      ...base,
      projectCredentials: (payload) =>
        rejectProjection
          ? Effect.fail(new Error(`Malformed ${secret}`))
          : base.projectCredentials(payload),
    }
    const store = makeInMemoryStore()
    const connection = Connections.create({
      provider,
      store,
    }).effect
    await Effect.runPromise(connection.setApiKey('conn_acme', 'stored-key', { replace: false }))
    rejectProjection = true

    const failure = await Effect.runPromise(Effect.flip(connection.credentialUse('conn_acme')))

    expect(failure).toMatchObject({
      _tag: 'TemporarilyUnavailable',
      cause: { _tag: 'ProviderFailure' },
    })
    expect([String(failure), JSON.stringify(failure), inspect(failure)].join('\n')).not.toContain(
      secret,
    )
  })

  test('replays an idempotent save receipt after a lost acknowledgement', async () => {
    const configured = fixture()
    configured.store.loseNextAcknowledgement('SaveCredential')

    await Effect.runPromise(
      configured.connection.setApiKey('conn_acme', '__retell_committed_key__', { replace: false }),
    )

    expect(configured.store.diagnostics.commands.SaveCredential).toBe(2)
    expect(
      value(
        (await Effect.runPromise(configured.connection.credentialUse('conn_acme'))).credentials
          .apiKey,
      ),
    ).toBe('__retell_committed_key__')
  })

  test('fences a delayed replacement after removal so stale key material cannot return', async () => {
    const configured = fixture()
    await Effect.runPromise(
      configured.connection.setApiKey('conn_acme', '__retell_original_key__', { replace: false }),
    )
    const held = configured.store.holdNext('SaveCredential', 'before')
    const delayedReplacement = Effect.runPromise(
      Effect.flip(
        configured.connection.setApiKey('conn_acme', '__retell_stale_replacement_key__', {
          replace: true,
        }),
      ),
    )

    await held.reached
    await Effect.runPromise(configured.connection.remove('conn_acme'))
    held.release()

    await expect(delayedReplacement).resolves.toMatchObject({
      _tag: 'CredentialConfigurationFailure',
      reason: 'Conflict',
    })
    await expect(
      Effect.runPromise(Effect.flip(configured.connection.credentialUse('conn_acme'))),
    ).resolves.toMatchObject({ _tag: 'AuthorizationRequired' })
    expect(
      JSON.stringify(
        configured.store.unsafeReadConnection({
          namespace: 'default',
          providerId: 'retell',
          connectionId: 'conn_acme',
        }),
      ),
    ).not.toContain('__retell_stale_replacement_key__')
  })

  test('runs a complete static API-key workflow at one Promise boundary', async () => {
    const configured = fixture()
    const connection = configured.manager.effect

    await Convex.run(
      promiseContext,
      Effect.gen(function* () {
        yield* connection.setApiKey('conn_acme', '__retell_promise_key__', { replace: false })
        const use = yield* connection.credentialUse('conn_acme')
        expect(value(use.credentials.apiKey)).toBe('__retell_promise_key__')
        yield* connection.remove('conn_acme')
      }),
    )

    await expect(
      Effect.runPromise(Effect.flip(connection.credentialUse('conn_acme'))),
    ).resolves.toMatchObject({
      _tag: 'AuthorizationRequired',
    })
  })
})
