import { Effect, Redacted } from 'effect'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { Connections } from '../../src/index.js'
import { makeDeterministicClientCredentialsProvider } from '../fixtures/client-credentials-provider.js'
import { makeInMemoryStore } from '../fixtures/in-memory-store.js'
import { makeTestClock } from '../fixtures/lifecycle-driver.js'
import { makeYotpoTokenSubstitute, yotpoTokenResponse } from '../fixtures/yotpo-server.js'
import { Yotpo } from '../../src/providers/yotpo/index.js'
import { Memory } from '../../src/stores/memory/index.js'

function fixture() {
  const provider = makeDeterministicClientCredentialsProvider()
  const manager = Connections.create({
    provider: provider.provider,
    store: makeInMemoryStore(),
  })
  return { provider, connection: manager.effect }
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('client credentials enrollment interface', () => {
  test('keeps enrollment and replacement local and only uses deliberately selected sources', async () => {
    const server = makeYotpoTokenSubstitute([
      yotpoTokenResponse({ access_token: 'first-token' }),
      yotpoTokenResponse({ access_token: 'replacement-token' }),
    ])
    const manager = Connections.create({
      provider: Yotpo.clientCredentials({ version: 'v1', fetch: server.fetch as typeof fetch }),
      store: Memory.store({ encryptionKey: 'KioqKioqKioqKioqKioqKioqKioqKioqKioqKioqKio=' }),
    })
    const connection = manager.effect

    await Effect.runPromise(
      connection.setClientCredentials(
        'conn_acme',
        { storeId: 'acme-store', apiSecret: Redacted.make('first-source') },
        { replace: false },
      ),
    )
    await expect(
      Effect.runPromise(
        Effect.flip(
          connection.setClientCredentials(
            'conn_acme',
            { storeId: 'acme-store', apiSecret: Redacted.make('second-source') },
            { replace: false },
          ),
        ),
      ),
    ).resolves.toMatchObject({ _tag: 'CredentialConfigurationFailure', reason: 'Conflict' })
    expect(server.requests()).toEqual([])
    const first = await Effect.runPromise(connection.credentials('conn_acme'))
    expect(Redacted.value(first.accessToken)).toBe('first-token')
    expect(server.requests().map((request) => JSON.parse(String(request.init?.body)))).toEqual([
      {
        client_id: 'acme-store',
        client_secret: 'first-source',
        grant_type: 'client_credentials',
      },
    ])

    await Effect.runPromise(
      connection.setClientCredentials(
        'conn_acme',
        { storeId: 'replacement-store', apiSecret: Redacted.make('replacement-source') },
        { replace: true },
      ),
    )
    expect(server.requests()).toHaveLength(1)
    const current = await Effect.runPromise(connection.credentials('conn_acme'))
    expect(Redacted.value(current.accessToken)).toBe('replacement-token')
    expect(current.storeId).toBe('replacement-store')
    expect(server.requests().map((request) => JSON.parse(String(request.init?.body)))).toEqual([
      {
        client_id: 'acme-store',
        client_secret: 'first-source',
        grant_type: 'client_credentials',
      },
      {
        client_id: 'replacement-store',
        client_secret: 'replacement-source',
        grant_type: 'client_credentials',
      },
    ])
  })

  test('keeps application-defined connection IDs independently enrolled and inspection local', async () => {
    const server = makeYotpoTokenSubstitute([
      yotpoTokenResponse({ access_token: 'acme-token' }),
      yotpoTokenResponse({ access_token: 'globex-token' }),
    ])
    const manager = Connections.create({
      provider: Yotpo.clientCredentials({ version: 'v1', fetch: server.fetch as typeof fetch }),
      store: Memory.store({ encryptionKey: 'KioqKioqKioqKioqKioqKioqKioqKioqKioqKioqKio=' }),
    })
    const acme = manager.effect
    const globex = manager.effect

    await Effect.runPromise(
      acme.setClientCredentials(
        'tenant_acme',
        { storeId: 'acme-store', apiSecret: Redacted.make('acme-source') },
        { replace: false },
      ),
    )

    await expect(Effect.runPromise(acme.inspect('tenant_acme'))).resolves.toEqual({
      savedAuthorization: true,
      credentialWork: 'idle',
    })
    await expect(Effect.runPromise(globex.inspect('tenant_globex'))).resolves.toEqual({
      savedAuthorization: false,
      credentialWork: 'idle',
    })
    expect(server.requests()).toEqual([])
    await Effect.runPromise(
      globex.setClientCredentials('tenant_globex', {
        storeId: 'globex-store',
        apiSecret: Redacted.make('globex-source'),
      }),
    )
    expect(server.requests()).toEqual([])
    const acmeCredentials = await Effect.runPromise(acme.credentials('tenant_acme'))
    const globexCredentials = await Effect.runPromise(globex.credentials('tenant_globex'))
    expect(Redacted.value(acmeCredentials.accessToken)).toBe('acme-token')
    expect(acmeCredentials.storeId).toBe('acme-store')
    expect(Redacted.value(globexCredentials.accessToken)).toBe('globex-token')
    expect(globexCredentials.storeId).toBe('globex-store')
    expect(
      Redacted.value((await Effect.runPromise(acme.credentials('tenant_acme'))).accessToken),
    ).toBe('acme-token')
    expect(server.requests().map((request) => JSON.parse(String(request.init?.body)))).toEqual([
      {
        client_id: 'acme-store',
        client_secret: 'acme-source',
        grant_type: 'client_credentials',
      },
      {
        client_id: 'globex-store',
        client_secret: 'globex-source',
        grant_type: 'client_credentials',
      },
    ])
  })

  test('keeps removal local and lazy', async () => {
    const configured = fixture()
    await Effect.runPromise(
      configured.connection.setClientCredentials(
        'store-connection',
        { source: Redacted.make('source') },
        { replace: false },
      ),
    )
    await Effect.runPromise(configured.connection.remove('store-connection'))

    expect(configured.provider.requests()).toBe(0)
    await expect(
      Effect.runPromise(configured.connection.inspect('store-connection')),
    ).resolves.toEqual({
      savedAuthorization: false,
      credentialWork: 'idle',
    })
  })
})

describe('client credentials rejection reporting interface', () => {
  test('returns a rejection operation bound to the issued credential use', async () => {
    const configured = fixture()
    await Effect.runPromise(
      configured.connection.setClientCredentials(
        'store-connection',
        { source: Redacted.make('source-secret') },
        { replace: false },
      ),
    )
    const issued = await Effect.runPromise(configured.connection.credentialUse('store-connection'))

    expect(typeof issued.reportRejected).toBe('function')
    await Effect.runPromise(issued.reportRejected())
    expect(
      Redacted.value(
        (await Effect.runPromise(configured.connection.credentialUse('store-connection')))
          .credentials.token,
      ),
    ).toBe('token-1')
    expect(configured.provider.requests()).toBe(2)
  })

  test('leaves protected-resource failures under application control without retrying them', async () => {
    const configured = fixture()
    const protectedResource = vi.fn<() => Promise<Response>>(
      async () => new Response(null, { status: 500 }),
    )
    vi.stubGlobal('fetch', protectedResource)
    await Effect.runPromise(
      configured.connection.setClientCredentials(
        'store-connection',
        { source: Redacted.make('source') },
        { replace: false },
      ),
    )
    const issued = await Effect.runPromise(configured.connection.credentialUse('store-connection'))

    // A non-authentication failure is deliberately not reported to Connections.
    expect((await fetch('https://resource.example.test/items')).status).toBe(500)
    const reused = await Effect.runPromise(configured.connection.credentialUse('store-connection'))

    expect(Redacted.value(reused.credentials.token)).toBe(Redacted.value(issued.credentials.token))
    expect(protectedResource).toHaveBeenCalledTimes(1)
    expect(configured.provider.requests()).toBe(1)
  })

  test('uses an explicit 401 report only to invalidate the handle and never replay a resource request', async () => {
    const configured = fixture()
    const protectedResource = vi.fn<() => Promise<Response>>(
      async () => new Response(null, { status: 401 }),
    )
    vi.stubGlobal('fetch', protectedResource)
    await Effect.runPromise(
      configured.connection.setClientCredentials(
        'store-connection',
        { source: Redacted.make('source') },
        { replace: false },
      ),
    )
    const issued = await Effect.runPromise(configured.connection.credentialUse('store-connection'))

    expect((await fetch('https://resource.example.test/items')).status).toBe(401)
    await Effect.runPromise(issued.reportRejected())
    await Effect.runPromise(configured.connection.credentialUse('store-connection'))

    expect(protectedResource).toHaveBeenCalledTimes(1)
    expect(configured.provider.requests()).toBe(2)
  })
})

describe('Yotpo V1 client credentials interface', () => {
  test('enrolls lazily, reuses without expiry, replaces after a reported 401, and removes locally', async () => {
    const clock = makeTestClock(1_000)
    const secret = 'yotpo-api-secret-canary'
    const server = makeYotpoTokenSubstitute([
      yotpoTokenResponse({ access_token: 'first-yotpo-token' }),
      yotpoTokenResponse({ access_token: 'replacement-yotpo-token' }),
    ])
    const manager = Connections.create({
      provider: Yotpo.clientCredentials({ version: 'v1', fetch: server.fetch as typeof fetch }),
      store: makeInMemoryStore(),
    })
    const connection = manager.effect
    const program = Effect.gen(function* () {
      yield* clock.initialize
      yield* connection.setClientCredentials(
        'store-connection',
        { storeId: 'store-id', apiSecret: Redacted.make(secret) },
        { replace: false },
      )
      const first = yield* connection.credentialUse('store-connection')
      const reused = yield* connection.credentialUse('store-connection')
      yield* clock.advanceBy(1_000)
      const later = yield* connection.credentialUse('store-connection')
      yield* later.reportRejected()
      const rejectionReplacement = yield* connection.credentialUse('store-connection')
      yield* connection.remove('store-connection')
      return { first, reused, later, rejectionReplacement }
    })

    const result = await Effect.runPromise(Effect.provide(program, clock.layer))
    expect(server.requests()).toHaveLength(2)
    expect(Redacted.value(result.first.credentials.accessToken)).toBe('first-yotpo-token')
    expect(Redacted.value(result.reused.credentials.accessToken)).toBe('first-yotpo-token')
    expect(Redacted.value(result.later.credentials.accessToken)).toBe('first-yotpo-token')
    expect(Redacted.value(result.rejectionReplacement.credentials.accessToken)).toBe(
      'replacement-yotpo-token',
    )
    expect(result.first.credentials.storeId).toBe('store-id')
    expect(JSON.stringify(result)).not.toContain(secret)
    await expect(Effect.runPromise(connection.inspect('store-connection'))).resolves.toEqual({
      savedAuthorization: false,
      credentialWork: 'idle',
    })
  })
})
