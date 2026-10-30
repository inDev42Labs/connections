import { Effect, Redacted } from 'effect'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { Connections, revealSecret } from '../../../src/index.js'
import { Shopify, type ShopifyOAuth } from '../../../src/providers/shopify/index.js'
import type { ConnectionStore } from '../../../src/stores/index.js'
import { Memory } from '../../../src/stores/memory/index.js'
import { makeInMemoryStore, replaceSavedCredentialPayload } from '../../fixtures/in-memory-store.js'

const shopDomain = 'trusted-shop.myshopify.com'
const shopOrigin = `https://${shopDomain}`
const redirectUri = 'https://app.example.test/oauth/shopify/callback'
const clientSecret = 'client-secret'
const scopes = ['read_products', 'write_orders'] as const
type TestFetch = (...args: Parameters<typeof globalThis.fetch>) => Promise<Response>

function manager(
  overrides: Partial<ShopifyOAuth['configuration']> = {},
  store: ConnectionStore<unknown, never> = Memory.store({
    encryptionKey: 'KioqKioqKioqKioqKioqKioqKioqKioqKioqKioqKio=',
  }),
) {
  return Connections.create({
    store,
    provider: Shopify.oauth({
      clientId: 'client-id',
      clientSecret,
      redirectUri,
      scopes,
      shopDomain,
      ...overrides,
    }),
  })
}
function tokenResponse(overrides: Record<string, unknown> = {}) {
  return {
    access_token: 'access-token',
    refresh_token: 'refresh-token',
    scope: scopes.join(','),
    expires_in: 3_600,
    refresh_token_expires_in: 7_776_000,
    ...overrides,
  }
}
// Historical provider data is used only to arrange corruption behind the store seam.
function storedPayload(overrides: Record<string, unknown>) {
  return JSON.stringify({
    schemaVersion: 1,
    accessToken: 'access-token',
    refreshToken: 'refresh-token',
    shopDomain,
    credentialExpiresAt: 3_601_000,
    refreshTokenExpiresAt: 7_776_001_000,
    ...overrides,
  })
}
async function signedCallback(
  state: string,
  overrides: Record<string, string> = {},
  extra: Record<string, string> = {},
) {
  const callback = new URL(redirectUri)
  callback.search = new URLSearchParams({
    code: 'authorization-code',
    host: 'dHJ1c3RlZC1zaG9wLm15c2hvcGlmeS5jb20vYWRtaW4',
    shop: shopDomain,
    state,
    timestamp: '1',
    ...overrides,
    ...extra,
  }).toString()
  const parameters = [...callback.searchParams.entries()].sort(([a], [b]) =>
    a < b ? -1 : a > b ? 1 : 0,
  )
  const encoder = new TextEncoder()
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(clientSecret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  const bytes = await crypto.subtle.sign(
    'HMAC',
    key,
    encoder.encode(parameters.map(([name, value]) => `${name}=${value}`).join('&')),
  )
  callback.searchParams.set(
    'hmac',
    [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, '0')).join(''),
  )
  return callback.toString()
}
async function start(configured: ReturnType<typeof manager>) {
  const result = await configured.startAuthorization('connection', { binding: 'session' })
  return new URL(result.url).searchParams.get('state')!
}
const complete = (configured: ReturnType<typeof manager>, callbackUrl: string) =>
  configured.completeAuthorization({ callbackUrl, binding: 'session', authorize: () => undefined })
async function authorize(configured = manager()) {
  await complete(configured, await signedCallback(await start(configured)))
  return configured.credentials('connection')
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe('Shopify browser OAuth', () => {
  test('constructs lazily and starts authorization at the configured shop without PKCE', async () => {
    const clientId = vi.fn<() => string>(() => 'client-id')
    const secret = vi.fn<() => Redacted.Redacted<string>>(() => Redacted.make(clientSecret))
    const redirect = vi.fn<() => string>(() => redirectUri)
    const fetch = vi.fn<TestFetch>()
    vi.stubGlobal('fetch', fetch)
    const configured = manager({
      clientId: Effect.sync(clientId),
      clientSecret: Effect.sync(secret),
      redirectUri: Effect.sync(redirect),
    })
    expect(clientId).not.toHaveBeenCalled()
    expect(secret).not.toHaveBeenCalled()
    expect(redirect).not.toHaveBeenCalled()
    expect(fetch).not.toHaveBeenCalled()
    const authorization = await configured.startAuthorization('connection', { binding: 'session' })
    const url = new URL(authorization.url)
    expect(url.origin).toBe(shopOrigin)
    expect(url.pathname).toBe('/admin/oauth/authorize')
    expect(url.searchParams.get('client_id')).toBe('client-id')
    expect(url.searchParams.get('scope')).toBe('read_products,write_orders')
    expect(url.searchParams.get('redirect_uri')).toBe(redirectUri)
    expect(url.searchParams.get('state')).toBeTruthy()
    expect(url.searchParams.has('code_challenge')).toBe(false)
    expect(url.searchParams.has('code_challenge_method')).toBe(false)
    expect(url.searchParams.has('grant_options[]')).toBe(false)
    expect(secret).not.toHaveBeenCalled()
    expect(fetch).not.toHaveBeenCalled()
  })

  test('accepts plain and lazy configuration without resolving getters during construction', async () => {
    const clientId = vi.fn<() => string>(() => 'client-id')
    const secret = vi.fn<() => string>(() => clientSecret)
    const redirect = vi.fn<() => string>(() => redirectUri)
    const fetch = vi.fn<TestFetch>(async () => Response.json(tokenResponse()))
    vi.stubGlobal('fetch', fetch)
    const configured = manager({ clientId, clientSecret: secret, redirectUri: redirect })
    expect(clientId).not.toHaveBeenCalled()
    expect(secret).not.toHaveBeenCalled()
    expect(redirect).not.toHaveBeenCalled()
    expect(fetch).not.toHaveBeenCalled()
    expect(revealSecret((await authorize(configured)).accessToken)).toBe('access-token')
    expect(new URLSearchParams(String(fetch.mock.calls[0]?.[1]?.body)).get('client_secret')).toBe(
      clientSecret,
    )
    expect(revealSecret((await authorize(manager())).accessToken)).toBe('access-token')
    expect(new URLSearchParams(String(fetch.mock.calls[1]?.[1]?.body)).get('client_secret')).toBe(
      clientSecret,
    )
  })

  test('rejects missing or throwing configuration without dispatch or secret disclosure', async () => {
    const fetch = vi.fn<TestFetch>()
    vi.stubGlobal('fetch', fetch)
    await expect(
      authorize(manager({ clientSecret: () => undefined as unknown as string })),
    ).rejects.toMatchObject({
      _tag: 'AuthorizationFailure',
      reason: 'InvalidCallback',
    })
    const canary = 'do-not-leak-this-secret'
    const failure = await manager({
      clientId: () => {
        throw new Error(canary)
      },
    })
      .startAuthorization('connection', { binding: 'session' })
      .catch((error: unknown) => error)
    expect(failure).toMatchObject({ _tag: 'AuthorizationFailure', reason: 'ProviderFailure' })
    expect(JSON.stringify(failure)).not.toContain(canary)
    expect(fetch).not.toHaveBeenCalled()
  })

  test('does not exchange a one-use code when configuration becomes unavailable after approval', async () => {
    const fetch = vi.fn<TestFetch>()
    vi.stubGlobal('fetch', fetch)
    const canary = 'secret-configuration-error'
    let available = true
    const configured = manager({
      clientSecret: () => {
        if (!available) throw new Error(canary)
        return clientSecret
      },
    })
    const callbackUrl = await signedCallback(await start(configured))
    const failure = await configured
      .completeAuthorization({
        callbackUrl,
        binding: 'session',
        authorize: () => {
          available = false
        },
      })
      .catch((error: unknown) => error)

    expect(failure).toMatchObject({ _tag: 'AuthorizationFailure', reason: 'ProviderFailure' })
    expect(JSON.stringify(failure)).not.toContain(canary)
    expect(fetch).not.toHaveBeenCalled()
  })

  test.each([
    'https://trusted-shop.myshopify.com',
    'Trusted-shop.myshopify.com',
    'trusted-shop.myshopify.com/path',
    'user@trusted-shop.myshopify.com',
    'nested.trusted-shop.myshopify.com',
    'trusted-shop-.myshopify.com',
    'localhost',
  ])('rejects a non-canonical shop domain without contacting it: %s', async (invalidShop) => {
    const fetch = vi.fn<TestFetch>()
    vi.stubGlobal('fetch', fetch)
    await expect(
      manager({ shopDomain: invalidShop }).startAuthorization('connection', { binding: 'session' }),
    ).rejects.toMatchObject({ reason: 'ProviderFailure' })
    expect(fetch).not.toHaveBeenCalled()
  })

  test('rejects empty or ambiguous scopes when authorization starts', async () => {
    for (const scope of ['', 'read_products,write_orders']) {
      await expect(
        manager({ scopes: [scope] }).startAuthorization('connection', { binding: 'session' }),
      ).rejects.toMatchObject({ reason: 'ProviderFailure' })
    }
  })

  test('only completes a correctly signed callback at the configured redirect', async () => {
    const fetch = vi.fn<TestFetch>(async () => Response.json(tokenResponse()))
    vi.stubGlobal('fetch', fetch)
    const configured = manager()
    const callback = await signedCallback(await start(configured))
    const invalid = new URL(callback)
    invalid.hostname = 'attacker.example'
    await expect(complete(configured, invalid.toString())).rejects.toMatchObject({
      reason: 'InvalidCallback',
    })
    expect(fetch).not.toHaveBeenCalled()
    await expect(complete(configured, callback)).resolves.toEqual({ connectionId: 'connection' })
    expect(revealSecret((await configured.credentials('connection')).accessToken)).toBe(
      'access-token',
    )
  })

  test('only accepts additional callback fields when the signature covers them', async () => {
    const fetch = vi.fn<TestFetch>(async () => Response.json(tokenResponse()))
    vi.stubGlobal('fetch', fetch)
    const configured = manager()
    const callback = await signedCallback(
      await start(configured),
      {},
      { future_parameter: 'provider-value' },
    )
    const invalid = new URL(callback)
    invalid.searchParams.set('future_parameter', 'attacker-value')
    await expect(complete(configured, invalid.toString())).rejects.toMatchObject({
      reason: 'InvalidCallback',
    })
    expect(fetch).not.toHaveBeenCalled()
    await expect(complete(configured, callback)).resolves.toEqual({ connectionId: 'connection' })
  })

  test('rejects signature tampering, a different signed shop, and duplicate callback fields before exchange', async () => {
    const fetch = vi.fn<TestFetch>()
    vi.stubGlobal('fetch', fetch)
    const configured = manager()
    const state = await start(configured)
    const tampered = new URL(await signedCallback(state))
    tampered.searchParams.set('code', 'tampered-code')
    const differentShop = await signedCallback(state, { shop: 'attacker-shop.myshopify.com' })
    const duplicate = new URL(await signedCallback(state))
    duplicate.searchParams.append('state', 'second-state')
    for (const callback of [tampered.toString(), differentShop, duplicate.toString()]) {
      await expect(complete(configured, callback)).rejects.toMatchObject({
        reason: 'InvalidCallback',
      })
    }
    expect(fetch).not.toHaveBeenCalled()
  })

  test('exchanges only at the configured shop and returns only redacted use credentials', async () => {
    const fetch = vi.fn<TestFetch>(async () => Response.json(tokenResponse()))
    vi.stubGlobal('fetch', fetch)
    const credentials = await authorize()
    const [url, request] = fetch.mock.calls[0]!
    expect(String(url)).toBe(`${shopOrigin}/admin/oauth/access_token`)
    expect(request).toMatchObject({ method: 'POST', redirect: 'error' })
    expect(new Headers(request?.headers).get('accept')).toBe('application/json')
    expect(new Headers(request?.headers).get('content-type')).toBe(
      'application/x-www-form-urlencoded',
    )
    expect(Object.fromEntries(new URLSearchParams(String(request?.body)))).toEqual({
      client_id: 'client-id',
      client_secret: clientSecret,
      code: 'authorization-code',
      expiring: '1',
    })
    expect(Object.keys(credentials).sort()).toEqual(['accessToken', 'shopDomain'])
    expect(revealSecret(credentials.accessToken)).toBe('access-token')
    expect(credentials.shopDomain).toBe(shopDomain)
  })

  test.each([
    { refresh_token: '' },
    { expires_in: 0 },
    { refresh_token_expires_in: '7776000' },
    { scope: 'read_products' },
  ])('does not authorize a malformed expiring offline-token response: %o', async (malformed) => {
    const fetch = vi.fn<TestFetch>(async () => Response.json(tokenResponse(malformed)))
    vi.stubGlobal('fetch', fetch)
    await expect(authorize()).rejects.toMatchObject({
      _tag: 'AuthorizationFailure',
      reason: 'ProviderFailure',
    })
    expect(fetch).toHaveBeenCalledOnce()
  })

  test.each([
    ['unsupported schema', (): string => storedPayload({ schemaVersion: 2 })],
    ['different shop', (): string => storedPayload({ shopDomain: 'other-shop.myshopify.com' })],
    ['invalid JSON', (): string => '{not-json'],
  ] as const)('does not return saved credentials containing %s', async (_name, payload) => {
    const fetch = vi.fn<TestFetch>(async () => Response.json(tokenResponse()))
    vi.stubGlobal('fetch', fetch)
    const store = makeInMemoryStore()
    const configured = manager({}, store)
    await authorize(configured)
    await replaceSavedCredentialPayload(
      store,
      { namespace: 'default', providerId: 'shopify', connectionId: 'connection' },
      payload(),
    )
    await expect(configured.credentials('connection')).rejects.toMatchObject({
      _tag: 'TemporarilyUnavailable',
      cause: { _tag: 'ProviderFailure' },
    })
    expect(fetch).toHaveBeenCalledOnce()
  })

  test('renews at reported expiry, uses the rotated token pair, and stops when the refresh token expires', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(1_000)
    const fetch = vi
      .fn<TestFetch>()
      .mockResolvedValueOnce(Response.json(tokenResponse()))
      .mockResolvedValueOnce(
        Response.json(
          tokenResponse({
            access_token: 'rotated-access',
            refresh_token: 'rotated-refresh',
            expires_in: 1_800,
            refresh_token_expires_in: 86_400,
          }),
        ),
      )
      .mockResolvedValueOnce(
        Response.json(
          tokenResponse({
            access_token: 'next-access',
            refresh_token: 'next-refresh',
            expires_in: 1,
            refresh_token_expires_in: 1,
          }),
        ),
      )
    vi.stubGlobal('fetch', fetch)
    const configured = manager()
    await authorize(configured)
    vi.setSystemTime(3_600_999)
    expect(revealSecret((await configured.credentials('connection')).accessToken)).toBe(
      'access-token',
    )
    expect(fetch).toHaveBeenCalledOnce()
    vi.setSystemTime(3_601_000)
    expect(revealSecret((await configured.credentials('connection')).accessToken)).toBe(
      'rotated-access',
    )
    expect(fetch).toHaveBeenCalledTimes(2)
    vi.setSystemTime(5_400_999)
    expect(revealSecret((await configured.credentials('connection')).accessToken)).toBe(
      'rotated-access',
    )
    expect(fetch).toHaveBeenCalledTimes(2)
    vi.setSystemTime(5_401_000)
    expect(revealSecret((await configured.credentials('connection')).accessToken)).toBe(
      'next-access',
    )
    expect(fetch).toHaveBeenCalledTimes(3)
    for (const [index, refreshToken] of [
      [1, 'refresh-token'],
      [2, 'rotated-refresh'],
    ] as const) {
      const [url, request] = fetch.mock.calls[index]!
      expect(String(url)).toBe(`${shopOrigin}/admin/oauth/access_token`)
      expect(request).toMatchObject({ method: 'POST', redirect: 'error' })
      expect(Object.fromEntries(new URLSearchParams(String(request?.body)))).toEqual({
        grant_type: 'refresh_token',
        client_id: 'client-id',
        client_secret: clientSecret,
        refresh_token: refreshToken,
      })
    }
    vi.setSystemTime(5_402_000)
    await expect(configured.credentials('connection')).rejects.toMatchObject({
      _tag: 'AuthorizationRequired',
    })
    expect(fetch).toHaveBeenCalledTimes(3)
  })

  test('recovers within a read after transport and throttling failures with at most three refresh attempts', async () => {
    const fetch = vi
      .fn<TestFetch>()
      .mockResolvedValueOnce(Response.json(tokenResponse()))
      .mockRejectedValueOnce(new TypeError('network failure'))
      .mockResolvedValueOnce(new Response(null, { status: 429 }))
      .mockResolvedValueOnce(Response.json(tokenResponse({ access_token: 'recovered-token' })))
    vi.stubGlobal('fetch', fetch)
    const configured = manager()
    await authorize(configured)
    await (await configured.credentialUse('connection')).reportRejected()
    expect(revealSecret((await configured.credentials('connection')).accessToken)).toBe(
      'recovered-token',
    )
    expect(fetch).toHaveBeenCalledTimes(4)
  })

  test('reports temporary unavailability after three server-error refresh attempts', async () => {
    const fetch = vi
      .fn<TestFetch>()
      .mockResolvedValueOnce(Response.json(tokenResponse()))
      .mockImplementation(async () => new Response(null, { status: 503 }))
    vi.stubGlobal('fetch', fetch)
    const configured = manager()
    await authorize(configured)
    await (await configured.credentialUse('connection')).reportRejected()
    await expect(configured.credentials('connection')).rejects.toMatchObject({
      _tag: 'TemporarilyUnavailable',
    })
    expect(fetch).toHaveBeenCalledTimes(4)
  })

  test.each([
    [401, 'AuthorizationRequired'],
    [400, 'TemporarilyUnavailable'],
    [403, 'TemporarilyUnavailable'],
  ] as const)('does not retry HTTP %s refresh failure and reports %s', async (status, expected) => {
    const fetch = vi
      .fn<TestFetch>()
      .mockResolvedValueOnce(Response.json(tokenResponse()))
      .mockImplementation(async () => new Response(null, { status }))
    vi.stubGlobal('fetch', fetch)
    const configured = manager()
    await authorize(configured)
    await (await configured.credentialUse('connection')).reportRejected()
    await expect(configured.credentials('connection')).rejects.toMatchObject({ _tag: expected })
    expect(fetch).toHaveBeenCalledTimes(2)
  })

  test('forbids token redirects and rejects oversized successful responses', async () => {
    const fetch = vi.fn<TestFetch>(async (_url, request) => {
      if (request?.redirect === 'error') throw new TypeError('redirect rejected')
      return Response.json(tokenResponse())
    })
    vi.stubGlobal('fetch', fetch)
    await expect(authorize()).rejects.toMatchObject({
      _tag: 'AuthorizationFailure',
      reason: 'InterventionRequired',
    })
    expect(fetch).toHaveBeenCalledOnce()
    vi.stubGlobal(
      'fetch',
      vi.fn<TestFetch>(async () =>
        Response.json(tokenResponse({ access_token: 'x'.repeat(1024 * 1024) })),
      ),
    )
    await expect(authorize()).rejects.toMatchObject({
      _tag: 'AuthorizationFailure',
      reason: 'ProviderFailure',
    })
  })
})
