import { Effect, Redacted } from 'effect'
import { describe, expect, test, vi } from 'vitest'
import type { ConnectionStore } from '../../src/core/contracts/store.js'
import { AesGcm } from '../../src/encryptors/aes-gcm/index.js'
import { Connections } from '../../src/index.js'
import { Salesforce } from '../../src/providers/salesforce/index.js'
import { Configuration, ConfigurationReadFailure } from '../../src/configuration/index.js'
import { Convex } from '../../src/stores/convex/index.js'
import { makeDeterministicClientCredentialsProvider } from '../fixtures/client-credentials-provider.js'

const throwingStore: ConnectionStore<never, never> = {
  readConnection: () => Effect.die(new Error('store accessed during configuration')),
  inspectConnection: () => Effect.die(new Error('store accessed during configuration')),
  readAuthorizationAttempt: () => Effect.die(new Error('store accessed during configuration')),
  protect: () => Effect.die(new Error('encryptor accessed during configuration')),
  unprotect: () => Effect.die(new Error('encryptor accessed during configuration')),
  execute: () => Effect.die(new Error('store accessed during configuration')),
  executeCredentialOperation: () => Effect.die(new Error('store accessed during configuration')),
}

describe('configuration helpers', () => {
  test.each([
    ['Missing', (): undefined => undefined],
    [
      'ReadFailed',
      (): never => {
        throw new Error('unavailable')
      },
    ],
  ] as const)('reports callback reads as %s without retaining the cause', async (reason, read) => {
    const failure = await Effect.runPromise(Effect.flip(Configuration.secret(read)))

    expect(failure).toBeInstanceOf(ConfigurationReadFailure)
    expect(failure).toMatchObject({ _tag: 'ConfigurationReadFailure', reason })
    expect(JSON.stringify(failure)).not.toContain('unavailable')
  })
})

describe('client credentials configuration', () => {
  test('constructs managers and connections without storage, source resolution, or provider traffic', () => {
    const provider = makeDeterministicClientCredentialsProvider()
    const manager = Connections.create({
      provider: provider.provider,
      store: throwingStore,
    })
    expect(manager.effect.credentials('conn_acme')).toBeDefined()
    expect(manager.effect.credentials('conn_globex')).toBeDefined()
    expect(provider.requests()).toBe(0)
  })

  test('inspects metadata without provider, encryption, or mutation capabilities', async () => {
    const provider = makeDeterministicClientCredentialsProvider()
    const metadataOnlyStore: ConnectionStore<never, never> = {
      ...throwingStore,
      inspectConnection: () =>
        Effect.succeed({
          schemaVersion: 1,
          key: {
            namespace: 'default',
            providerId: provider.provider.id,
            connectionId: 'conn_acme',
          },
          savedAuthorization: true,
          credentialWork: 'idle',
        }),
    }
    const connection = Connections.create({
      provider: provider.provider,
      store: metadataOnlyStore,
    }).effect

    await expect(Effect.runPromise(connection.inspect('conn_acme'))).resolves.toEqual({
      savedAuthorization: true,
      credentialWork: 'idle',
    })
    expect(provider.requests()).toBe(0)
  })
})

describe('Salesforce configuration', () => {
  test('constructs providers, managers, and handles without accessing runtime dependencies', () => {
    const configurationAccess = vi.fn<() => never>(() => {
      throw new Error('configuration accessed during construction')
    })
    const fetchAccess = vi.fn<() => never>(() => {
      throw new Error('fetch accessed during configuration')
    })
    vi.stubGlobal('fetch', fetchAccess)

    const provider = Salesforce.oauth({
      clientId: Configuration.string(configurationAccess),
      clientSecret: Configuration.secret(configurationAccess),
      redirectUri: Configuration.string(configurationAccess),
      scopes: ['api', 'refresh_token'],
    })
    const manager = Connections.create({
      provider,
      store: throwingStore,
    })
    expect(manager.effect.credentials('conn_acme')).toBeDefined()
    expect(manager.effect.credentials('conn_globex')).toBeDefined()
    expect(configurationAccess).not.toHaveBeenCalled()
    expect(fetchAccess).not.toHaveBeenCalled()

    vi.unstubAllGlobals()
  })

  test('reuses one configured store and provider across managers without resolving secrets', () => {
    const secretAccess = vi.fn<() => Redacted.Redacted<string>>(() =>
      Redacted.make('client-secret'),
    )
    const provider = Salesforce.oauth({
      clientId: 'client-id',
      clientSecret: Configuration.secret(secretAccess),
      redirectUri: 'https://app.example.invalid/oauth/callback',
      scopes: ['api', 'refresh_token'],
    })

    const first = Connections.create({ provider, store: throwingStore })
    const second = Connections.create({ provider, store: throwingStore })

    expect(first.effect.credentials('shared-id')).toBeDefined()
    expect(second.effect.credentials('shared-id')).toBeDefined()
    expect(secretAccess).not.toHaveBeenCalled()
  })

  test('constructs built-in store and layer descriptions without component, key, or context access', () => {
    const componentAccess = vi.fn<() => never>(() => {
      throw new Error('component accessed during configuration')
    })
    const keyAccess = vi.fn<() => never>(() => {
      throw new Error('key accessed during configuration')
    })
    const contextAccess = vi.fn<() => never>(() => {
      throw new Error('context accessed during configuration')
    })
    const component = {
      get connections(): never {
        return componentAccess()
      },
      get attempts(): never {
        return componentAccess()
      },
      get operations(): never {
        return componentAccess()
      },
    }
    const context = {
      get runQuery(): never {
        return contextAccess()
      },
      get runMutation(): never {
        return contextAccess()
      },
    }

    const store = Convex.store({
      component: component,
      encryptor: AesGcm.encryptor({ key: Configuration.secret(keyAccess) }),
    })
    const invocationLayer = Convex.layer(context)
    const provider = Salesforce.oauth({
      clientId: 'client-id',
      clientSecret: Configuration.secret('SALESFORCE_CLIENT_SECRET'),
      redirectUri: 'https://app.example.invalid/oauth/callback',
      scopes: ['api'],
    })
    const manager = Connections.create({ provider, store })

    expect(manager.effect.credentials('connection')).toBeDefined()
    expect(invocationLayer).toBeDefined()
    expect(componentAccess).not.toHaveBeenCalled()
    expect(keyAccess).not.toHaveBeenCalled()
    expect(contextAccess).not.toHaveBeenCalled()
  })
})
