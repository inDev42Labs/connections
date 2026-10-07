import { Effect, Redacted } from 'effect'
import { afterEach, describe, expect, test, vi } from 'vitest'
import {
  Shopify,
  type ShopifyOAuth,
  type ShopifySecret,
  type ShopifyText,
} from '../../../src/providers/shopify/index.js'

const shopDomain = 'trusted-shop.myshopify.com'
const shopOrigin = `https://${shopDomain}`
const redirectUri = 'https://app.example.test/oauth/shopify/callback'
const clientSecret = 'client-secret'
const scopes = ['read_products', 'write_orders'] as const

type TestFetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>

interface TestProviderOptions {
  readonly clientId?: ShopifyText
  readonly clientSecret?: ShopifySecret
  readonly redirectUri?: ShopifyText
  readonly scopes?: readonly [string, ...string[]]
  readonly shopDomain?: string
}

function provider(overrides: TestProviderOptions = {}): ShopifyOAuth {
  return Shopify.oauth({
    clientId: 'client-id',
    clientSecret: Effect.succeed(Redacted.make(clientSecret)),
    redirectUri,
    scopes,
    shopDomain,
    ...overrides,
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

function exchange(shopify = provider()) {
  return shopify.exchangeAuthorizationCode({
    code: Redacted.make('authorization-code'),
    codeVerifier: Redacted.make('workflow-pkce-verifier'),
    now: 1_000,
  })
}

function storedPayload(overrides: Record<string, unknown> = {}): Redacted.Redacted<string> {
  return Redacted.make(
    JSON.stringify({
      schemaVersion: 1,
      accessToken: 'access-token',
      refreshToken: 'refresh-token',
      shopDomain,
      credentialExpiresAt: 3_601_000,
      refreshTokenExpiresAt: 7_776_001_000,
      ...overrides,
    }),
  )
}

function hex(bytes: ArrayBuffer): string {
  return [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}

async function signedCallback(
  overrides: Partial<Record<'code' | 'host' | 'shop' | 'state' | 'timestamp', string>> = {},
  extra: Record<string, string> = {},
): Promise<string> {
  const callback = new URL(redirectUri)
  callback.search = new URLSearchParams({
    code: 'authorization-code',
    host: 'dHJ1c3RlZC1zaG9wLm15c2hvcGlmeS5jb20vYWRtaW4',
    shop: shopDomain,
    state: 'state-value',
    timestamp: '1',
    ...overrides,
    ...extra,
  }).toString()
  const parameters = [...callback.searchParams.entries()]
  parameters.sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
  const message = parameters.map(([name, value]) => `${name}=${value}`).join('&')
  const encoder = new TextEncoder()
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(clientSecret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  callback.searchParams.set(
    'hmac',
    hex(await crypto.subtle.sign('HMAC', key, encoder.encode(message))),
  )
  return callback.toString()
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('Shopify OAuth', () => {
  test('constructs lazily and builds a standalone authorization URL without PKCE', async () => {
    const clientIdAccess = vi.fn<() => string>(() => 'client-id')
    const secretAccess = vi.fn<() => Redacted.Redacted<string>>(() => Redacted.make(clientSecret))
    const redirectAccess = vi.fn<() => string>(() => redirectUri)
    const fetchAccess = vi.fn<TestFetch>()
    vi.stubGlobal('fetch', fetchAccess)

    const shopify = provider({
      clientId: Effect.sync(clientIdAccess),
      clientSecret: Effect.sync(secretAccess),
      redirectUri: Effect.sync(redirectAccess),
    })

    expect(clientIdAccess).not.toHaveBeenCalled()
    expect(secretAccess).not.toHaveBeenCalled()
    expect(redirectAccess).not.toHaveBeenCalled()
    expect(fetchAccess).not.toHaveBeenCalled()

    const value = await Effect.runPromise(
      shopify.authorizationUrl({ state: 'state-value', codeChallenge: 'ignored-challenge' }),
    )
    const url = new URL(value)

    expect(url.origin).toBe(shopOrigin)
    expect(url.pathname).toBe('/admin/oauth/authorize')
    expect(Object.fromEntries(url.searchParams.entries())).toEqual({
      client_id: 'client-id',
      scope: 'read_products,write_orders',
      redirect_uri: redirectUri,
      state: 'state-value',
    })
    expect(url.searchParams.has('code_challenge')).toBe(false)
    expect(url.searchParams.has('code_challenge_method')).toBe(false)
    expect(url.searchParams.has('grant_options[]')).toBe(false)
    expect(secretAccess).not.toHaveBeenCalled()
    expect(fetchAccess).not.toHaveBeenCalled()
  })

  test('supports plain and lazy configuration without resolving getters during construction', async () => {
    const clientId = vi.fn<() => string>(() => 'client-id')
    const secret = vi.fn<() => string>(() => clientSecret)
    const redirect = vi.fn<() => string>(() => redirectUri)
    const fetchMock = vi.fn<TestFetch>(() => Promise.resolve(Response.json(tokenResponse())))
    vi.stubGlobal('fetch', fetchMock)

    const lazyShopify = Shopify.oauth({
      clientId,
      clientSecret: secret,
      redirectUri: redirect,
      scopes,
      shopDomain,
    })
    expect(clientId).not.toHaveBeenCalled()
    expect(secret).not.toHaveBeenCalled()
    expect(redirect).not.toHaveBeenCalled()
    expect(fetchMock).not.toHaveBeenCalled()

    await Effect.runPromise(
      lazyShopify.authorizationUrl({ state: 'state-value', codeChallenge: 'ignored-challenge' }),
    )
    expect(clientId).toHaveBeenCalledOnce()
    expect(redirect).toHaveBeenCalledOnce()
    expect(secret).not.toHaveBeenCalled()

    await Effect.runPromise(lazyShopify.parseAuthorizationCallback(await signedCallback()))
    expect(secret).toHaveBeenCalledOnce()
    await Effect.runPromise(exchange(lazyShopify))
    expect(fetchMock).toHaveBeenCalledOnce()
    const requestBody = fetchMock.mock.calls[0]?.[1]?.body
    expect(requestBody).toBeInstanceOf(URLSearchParams)
    expect((requestBody as URLSearchParams).get('client_secret')).toBe(clientSecret)

    const plainShopify = Shopify.oauth({
      clientId: 'client-id',
      clientSecret,
      redirectUri,
      scopes,
      shopDomain,
    })
    await Effect.runPromise(exchange(plainShopify))
    const plainBody = fetchMock.mock.calls[1]?.[1]?.body
    expect(plainBody).toBeInstanceOf(URLSearchParams)
    expect((plainBody as URLSearchParams).get('client_secret')).toBe(clientSecret)
  })

  test('maps missing or throwing configuration getters to safe invalid configuration failures', async () => {
    const fetchMock = vi.fn<TestFetch>()
    vi.stubGlobal('fetch', fetchMock)
    const missingSecret = provider({ clientSecret: () => undefined as unknown as string })
    const secretFailure = await Effect.runPromise(Effect.flip(exchange(missingSecret)))
    expect(secretFailure).toMatchObject({ reason: 'InvalidConfiguration' })

    const secretInThrownError = 'do-not-leak-this-secret'
    const throwingClientId = provider({
      clientId: () => {
        throw new Error(secretInThrownError)
      },
    })
    const clientIdFailure = await Effect.runPromise(
      Effect.flip(
        throwingClientId.authorizationUrl({
          state: 'state-value',
          codeChallenge: 'ignored-challenge',
        }),
      ),
    )
    expect(clientIdFailure).toMatchObject({ reason: 'InvalidConfiguration' })
    expect(JSON.stringify(clientIdFailure)).not.toContain(secretInThrownError)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  test.each([
    'https://trusted-shop.myshopify.com',
    'Trusted-shop.myshopify.com',
    'trusted-shop.myshopify.com/path',
    'user@trusted-shop.myshopify.com',
    'nested.trusted-shop.myshopify.com',
    'trusted-shop-.myshopify.com',
    'localhost',
  ])('rejects a non-canonical configured shop domain without fetching: %s', async (invalidShop) => {
    const fetchAccess = vi.fn<TestFetch>()
    vi.stubGlobal('fetch', fetchAccess)

    const failure = await Effect.runPromise(
      Effect.flip(
        provider({ shopDomain: invalidShop }).authorizationUrl({
          state: 'state-value',
          codeChallenge: 'ignored-challenge',
        }),
      ),
    )

    expect(failure).toMatchObject({ reason: 'InvalidConfiguration' })
    expect(fetchAccess).not.toHaveBeenCalled()
  })

  test('rejects empty or ambiguous scope configuration lazily', async () => {
    const emptyFailure = await Effect.runPromise(
      Effect.flip(
        provider({ scopes: [''] }).authorizationUrl({
          state: 'state-value',
          codeChallenge: 'ignored-challenge',
        }),
      ),
    )
    const commaFailure = await Effect.runPromise(
      Effect.flip(
        provider({ scopes: ['read_products,write_orders'] }).authorizationUrl({
          state: 'state-value',
          codeChallenge: 'ignored-challenge',
        }),
      ),
    )

    expect(emptyFailure).toMatchObject({ reason: 'InvalidConfiguration' })
    expect(commaFailure).toMatchObject({ reason: 'InvalidConfiguration' })
  })

  test('accepts a correctly signed callback only at the configured redirect', async () => {
    const callback = await Effect.runPromise(
      provider().parseAuthorizationCallback(await signedCallback()),
    )

    expect(callback._tag).toBe('AuthorizationGranted')
    if (callback._tag !== 'AuthorizationGranted') throw new Error('Expected authorization grant')
    expect(callback.state).toBe('state-value')
    expect(Redacted.value(callback.code)).toBe('authorization-code')

    const wrongRedirect = new URL(await signedCallback())
    wrongRedirect.hostname = 'attacker.example'
    const failure = await Effect.runPromise(
      Effect.flip(provider().parseAuthorizationCallback(wrongRedirect.toString())),
    )
    expect(failure).toMatchObject({ reason: 'InvalidCallback' })
  })

  test('accepts additional unambiguous callback fields only when the HMAC covers them', async () => {
    const signed = await signedCallback({}, { future_parameter: 'provider-value' })
    const callback = await Effect.runPromise(provider().parseAuthorizationCallback(signed))

    expect(callback._tag).toBe('AuthorizationGranted')

    const tampered = new URL(signed)
    tampered.searchParams.set('future_parameter', 'attacker-value')
    const failure = await Effect.runPromise(
      Effect.flip(provider().parseAuthorizationCallback(tampered.toString())),
    )
    expect(failure).toMatchObject({ reason: 'InvalidCallback' })
  })

  test('rejects HMAC tampering, a different signed shop, and duplicate callback fields', async () => {
    const tampered = new URL(await signedCallback())
    tampered.searchParams.set('code', 'tampered-code')
    const differentShop = await signedCallback({ shop: 'attacker-shop.myshopify.com' })
    const duplicate = new URL(await signedCallback())
    duplicate.searchParams.append('state', 'second-state')

    for (const callbackUrl of [tampered.toString(), differentShop, duplicate.toString()]) {
      const failure = await Effect.runPromise(
        Effect.flip(provider().parseAuthorizationCallback(callbackUrl)),
      )
      expect(failure).toMatchObject({ reason: 'InvalidCallback' })
    }
  })

  test('exchanges at the fixed shop origin, ignores workflow PKCE, and projects only safe credentials', async () => {
    const fetchMock = vi.fn<TestFetch>(() => Promise.resolve(Response.json(tokenResponse())))
    vi.stubGlobal('fetch', fetchMock)

    const credentials = await Effect.runPromise(exchange())
    const request = fetchMock.mock.calls[0]
    expect(request).toBeDefined()
    const [input, init] = request!
    const url = new URL(String(input))
    const body = init?.body

    expect(url.toString()).toBe(`${shopOrigin}/admin/oauth/access_token`)
    expect(url.search).toBe('')
    expect(init?.method).toBe('POST')
    expect(init?.redirect).toBe('error')
    expect(init?.headers).toEqual({
      accept: 'application/json',
      'content-type': 'application/x-www-form-urlencoded',
    })
    expect(body).toBeInstanceOf(URLSearchParams)
    expect(Object.fromEntries((body as URLSearchParams).entries())).toEqual({
      client_id: 'client-id',
      client_secret: clientSecret,
      code: 'authorization-code',
      expiring: '1',
    })
    expect((body as URLSearchParams).has('code_verifier')).toBe(false)
    expect(credentials.credentialExpiresAt).toBe(3_601_000)
    expect(JSON.parse(Redacted.value(credentials.protectedPayload))).toEqual({
      schemaVersion: 1,
      accessToken: 'access-token',
      refreshToken: 'refresh-token',
      shopDomain,
      credentialExpiresAt: 3_601_000,
      refreshTokenExpiresAt: 7_776_001_000,
    })

    const projected = await Effect.runPromise(
      provider().projectCredentials(credentials.protectedPayload),
    )
    expect(Object.keys(projected).sort()).toEqual(['accessToken', 'shopDomain'])
    expect(Redacted.value(projected.accessToken)).toBe('access-token')
    expect(projected.shopDomain).toBe(shopDomain)
  })

  test.each([
    { refresh_token: '' },
    { expires_in: 0 },
    { refresh_token_expires_in: '7776000' },
    { scope: 'read_products' },
  ])('rejects a malformed expiring offline token response: %o', async (malformed) => {
    vi.stubGlobal(
      'fetch',
      vi.fn<TestFetch>(() => Promise.resolve(Response.json(tokenResponse(malformed)))),
    )

    const failure = await Effect.runPromise(Effect.flip(exchange()))

    expect(failure).toMatchObject({ reason: 'MalformedResponse' })
  })

  test('rejects malformed or cross-shop persisted payloads', async () => {
    for (const payload of [
      storedPayload({ schemaVersion: 2 }),
      storedPayload({ shopDomain: 'other-shop.myshopify.com' }),
      Redacted.make('{not-json'),
    ]) {
      const failure = await Effect.runPromise(Effect.flip(provider().projectCredentials(payload)))
      expect(failure).toMatchObject({ reason: 'InvalidStoredCredentials' })
    }
  })

  test('refresh atomically rotates the access and refresh token pair at the fixed origin', async () => {
    const fetchMock = vi.fn<TestFetch>(() =>
      Promise.resolve(
        Response.json(
          tokenResponse({
            access_token: 'rotated-access-token',
            refresh_token: 'rotated-refresh-token',
            expires_in: 1_800,
            refresh_token_expires_in: 86_400,
          }),
        ),
      ),
    )
    vi.stubGlobal('fetch', fetchMock)

    const outcome = await Effect.runPromise(
      provider().refreshCredentials({ protectedPayload: storedPayload(), now: 5_000 }),
    )

    expect(outcome._tag).toBe('Refreshed')
    if (outcome._tag !== 'Refreshed') throw new Error('Expected refreshed credentials')
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const request = fetchMock.mock.calls[0]
    expect(request).toBeDefined()
    const [input, init] = request!
    expect(new URL(String(input)).toString()).toBe(`${shopOrigin}/admin/oauth/access_token`)
    expect(init?.method).toBe('POST')
    expect(init?.redirect).toBe('error')
    const refreshBody = init?.body
    expect(refreshBody).toBeInstanceOf(URLSearchParams)
    expect(Object.fromEntries((refreshBody as URLSearchParams).entries())).toEqual({
      grant_type: 'refresh_token',
      client_id: 'client-id',
      client_secret: clientSecret,
      refresh_token: 'refresh-token',
    })
    expect(outcome.credentials.credentialExpiresAt).toBe(1_805_000)
    expect(JSON.parse(Redacted.value(outcome.credentials.protectedPayload))).toEqual({
      schemaVersion: 1,
      accessToken: 'rotated-access-token',
      refreshToken: 'rotated-refresh-token',
      shopDomain,
      credentialExpiresAt: 1_805_000,
      refreshTokenExpiresAt: 86_405_000,
    })
  })

  test('retries only transport, 429, and 5xx refresh outcomes and remains bounded', async () => {
    const eventualSuccess = vi
      .fn<TestFetch>()
      .mockRejectedValueOnce(new TypeError('network failure'))
      .mockResolvedValueOnce(new Response(null, { status: 429 }))
      .mockResolvedValueOnce(Response.json(tokenResponse({ access_token: 'recovered-token' })))
    vi.stubGlobal('fetch', eventualSuccess)

    const recovered = await Effect.runPromise(
      provider().refreshCredentials({ protectedPayload: storedPayload(), now: 5_000 }),
    )
    expect(recovered._tag).toBe('Refreshed')
    expect(eventualSuccess).toHaveBeenCalledTimes(3)

    const exhausted = vi.fn<TestFetch>(() => Promise.resolve(new Response(null, { status: 503 })))
    vi.stubGlobal('fetch', exhausted)
    const unknown = await Effect.runPromise(
      provider().refreshCredentials({ protectedPayload: storedPayload(), now: 5_000 }),
    )
    expect(unknown).toEqual({ _tag: 'ProviderOutcomeUnknown' })
    expect(exhausted).toHaveBeenCalledTimes(3)

    for (const [status, expected] of [
      [401, 'ProviderRejected'],
      [400, 'ProviderFailure'],
      [403, 'ProviderFailure'],
    ] as const) {
      const fetchMock = vi.fn<TestFetch>(() => Promise.resolve(new Response(null, { status })))
      vi.stubGlobal('fetch', fetchMock)
      const outcome = await Effect.runPromise(
        provider().refreshCredentials({ protectedPayload: storedPayload(), now: 5_000 }),
      )
      expect(outcome).toEqual({ _tag: expected })
      expect(fetchMock).toHaveBeenCalledTimes(1)
    }
  })

  test('rejects redirects and bounds successful response bodies', async () => {
    const redirectingFetch = vi.fn<TestFetch>((_input, init): Promise<Response> => {
      if (init?.redirect === 'error') {
        return Promise.reject(new TypeError('redirect rejected'))
      }
      return Promise.resolve(Response.json(tokenResponse()))
    })
    vi.stubGlobal('fetch', redirectingFetch)

    const redirectFailure = await Effect.runPromise(Effect.flip(exchange()))
    expect(redirectFailure).toMatchObject({ reason: 'TransportFailure' })
    expect(redirectingFetch).toHaveBeenCalledTimes(1)

    vi.stubGlobal(
      'fetch',
      vi.fn<TestFetch>(() =>
        Promise.resolve(new Response(new Uint8Array(1024 * 1024 + 1), { status: 200 })),
      ),
    )
    const bodyFailure = await Effect.runPromise(Effect.flip(exchange()))
    expect(bodyFailure).toMatchObject({ reason: 'MalformedResponse' })
  })
})
