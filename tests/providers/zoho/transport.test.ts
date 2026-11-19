import { inspect } from 'node:util'
import { Effect, Redacted } from 'effect'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { Connections, revealSecret } from '../../../src/index.js'
import { Zoho, type ZohoOAuth, type ZohoSelfClient } from '../../../src/providers/zoho/index.js'
import { Memory } from '../../../src/stores/memory/index.js'

const accountsOrigin = 'https://accounts.zoho.example'
const redirectUri = 'https://app.example.test/oauth/zoho/callback'
const encryptionKey = 'KioqKioqKioqKioqKioqKioqKioqKioqKioqKioqKio='
type TestFetch = (...args: Parameters<typeof globalThis.fetch>) => Promise<Response>
const store = () => Memory.store({ encryptionKey })

function manager(overrides: Partial<ZohoOAuth['configuration']> = {}, sharedStore = store()) {
  return Connections.create({
    provider: Zoho.oauth({
      clientId: 'client-id',
      clientSecret: 'client-secret',
      redirectUri,
      scopes: ['ZohoCRM.modules.ALL', 'ZohoCRM.settings.ALL'],
      accountsOrigin,
      ...overrides,
    }),
    store: sharedStore,
  })
}
function selfClient(
  overrides: Partial<ZohoSelfClient['configuration']> = {},
  sharedStore = store(),
) {
  return Connections.create({
    provider: Zoho.selfClient({
      clientId: 'client-id',
      clientSecret: 'client-secret',
      accountsOrigin,
      ...overrides,
    }),
    store: sharedStore,
  })
}
function callback(authorizationUrl: string) {
  const url = new URL(redirectUri)
  url.search = new URLSearchParams({
    code: 'authorization-code',
    state: new URL(authorizationUrl).searchParams.get('state')!,
  }).toString()
  return url.toString()
}
async function authorize(configured = manager()) {
  const start = await configured.startAuthorization('connection', { binding: 'session' })
  await configured.completeAuthorization({
    callbackUrl: callback(start.url),
    binding: 'session',
    authorize: () => undefined,
  })
  return configured.credentials('connection')
}
const enroll = (configured: ReturnType<typeof selfClient>, code = 'one-time-code') =>
  configured.enrollCode('connection', { code, authorize: () => undefined })
function tokenResponse(overrides: Record<string, unknown> = {}) {
  return {
    access_token: 'access-token',
    refresh_token: 'refresh-token',
    api_domain: 'https://www.zohoapis.example',
    token_type: 'Bearer',
    expires_in: 3_600,
    ...overrides,
  }
}

afterEach(() => vi.unstubAllGlobals())

describe('Zoho browser OAuth', () => {
  test('constructs lazily and starts regional authorization with Zoho conventions and PKCE', async () => {
    const clientId = vi.fn<() => string>(() => 'client-id')
    const secret = vi.fn<() => Redacted.Redacted<string>>(() => Redacted.make('client-secret'))
    const accounts = vi.fn<() => string>(() => accountsOrigin)
    const redirect = vi.fn<() => string>(() => redirectUri)
    const fetch = vi.fn<TestFetch>()
    vi.stubGlobal('fetch', fetch)
    const configured = manager({
      clientId: Effect.sync(clientId),
      clientSecret: Effect.sync(secret),
      accountsOrigin: Effect.sync(accounts),
      redirectUri: Effect.sync(redirect),
    })
    expect(clientId).not.toHaveBeenCalled()
    expect(secret).not.toHaveBeenCalled()
    expect(accounts).not.toHaveBeenCalled()
    expect(redirect).not.toHaveBeenCalled()
    const start = await configured.startAuthorization('connection', { binding: 'session' })
    const url = new URL(start.url)
    expect(url.origin).toBe(accountsOrigin)
    expect(url.pathname).toBe('/oauth/v2/auth')
    expect(url.searchParams.get('response_type')).toBe('code')
    expect(url.searchParams.get('client_id')).toBe('client-id')
    expect(url.searchParams.get('redirect_uri')).toBe(redirectUri)
    expect(url.searchParams.get('scope')).toBe('ZohoCRM.modules.ALL,ZohoCRM.settings.ALL')
    expect(url.searchParams.get('access_type')).toBe('offline')
    expect(url.searchParams.get('state')).toBeTruthy()
    expect(url.searchParams.get('code_challenge')).toBeTruthy()
    expect(url.searchParams.get('code_challenge_method')).toBe('S256')
    expect(secret).not.toHaveBeenCalled()
    expect(fetch).not.toHaveBeenCalled()
  })

  test('accepts plain and lazy configuration without resolving getters during construction', async () => {
    const clientId = vi.fn<() => string>(() => 'client-id')
    const clientSecret = vi.fn<() => string>(() => 'client-secret')
    const redirect = vi.fn<() => string>(() => redirectUri)
    const accounts = vi.fn<() => string>(() => accountsOrigin)
    const fetch = vi.fn<TestFetch>(async () => Response.json(tokenResponse()))
    vi.stubGlobal('fetch', fetch)
    const lazy = manager({
      clientId,
      clientSecret,
      redirectUri: redirect,
      accountsOrigin: accounts,
    })
    expect(clientId).not.toHaveBeenCalled()
    expect(clientSecret).not.toHaveBeenCalled()
    expect(redirect).not.toHaveBeenCalled()
    expect(accounts).not.toHaveBeenCalled()
    expect(fetch).not.toHaveBeenCalled()
    expect(revealSecret((await authorize(lazy)).accessToken)).toBe('access-token')
    expect(new URLSearchParams(String(fetch.mock.calls[0]?.[1]?.body)).get('client_secret')).toBe(
      'client-secret',
    )
    expect(
      revealSecret((await authorize(manager({ clientSecret: 'plain-secret' }))).accessToken),
    ).toBe('access-token')
    expect(new URLSearchParams(String(fetch.mock.calls[1]?.[1]?.body)).get('client_secret')).toBe(
      'plain-secret',
    )
  })

  test('fails safely without dispatch when configuration is missing or throws', async () => {
    const fetch = vi.fn<TestFetch>()
    vi.stubGlobal('fetch', fetch)
    await expect(
      authorize(manager({ clientSecret: () => undefined as unknown as string })),
    ).rejects.toMatchObject({
      _tag: 'AuthorizationFailure',
      reason: 'ProviderFailure',
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
    expect([String(failure), JSON.stringify(failure), inspect(failure)].join('\n')).not.toContain(
      canary,
    )
    expect(fetch).not.toHaveBeenCalled()
  })

  test('preserves configured scopes without freezing or capturing later mutations to caller input', async () => {
    const scopes: [string, ...string[]] = ['ZohoCRM.modules.ALL']
    const configured = manager({ scopes })
    scopes.push('ZohoCRM.settings.ALL')
    const start = await configured.startAuthorization('connection', { binding: 'session' })
    expect(new URL(start.url).searchParams.get('scope')).toBe('ZohoCRM.modules.ALL')
    expect(scopes).toEqual(['ZohoCRM.modules.ALL', 'ZohoCRM.settings.ALL'])
  })

  test('only completes callbacks matching the configured redirect URI', async () => {
    const fetch = vi.fn<TestFetch>(async () => Response.json(tokenResponse()))
    vi.stubGlobal('fetch', fetch)
    const configured = manager()
    const start = await configured.startAuthorization('connection', { binding: 'session' })
    const invalid = new URL(callback(start.url))
    invalid.hostname = 'attacker.example'
    await expect(
      configured.completeAuthorization({
        callbackUrl: invalid.toString(),
        binding: 'session',
        authorize: () => undefined,
      }),
    ).rejects.toMatchObject({ reason: 'InvalidCallback' })
    expect(fetch).not.toHaveBeenCalled()
    await expect(
      configured.completeAuthorization({
        callbackUrl: callback(start.url),
        binding: 'session',
        authorize: () => undefined,
      }),
    ).resolves.toEqual({ connectionId: 'connection' })
    expect(revealSecret((await configured.credentials('connection')).accessToken)).toBe(
      'access-token',
    )
  })

  test('exchanges a form POST only at the configured origin and returns redacted use credentials', async () => {
    const fetch = vi.fn<TestFetch>(async () => Response.json(tokenResponse()))
    vi.stubGlobal('fetch', fetch)
    const credentials = await authorize()
    const [url, request] = fetch.mock.calls[0]!
    expect(String(url)).toBe(`${accountsOrigin}/oauth/v2/token`)
    expect(request).toMatchObject({ method: 'POST', redirect: 'error' })
    expect(new Headers(request?.headers).get('content-type')).toBe(
      'application/x-www-form-urlencoded',
    )
    expect(Object.fromEntries(new URLSearchParams(String(request?.body)))).toEqual({
      grant_type: 'authorization_code',
      code: 'authorization-code',
      client_id: 'client-id',
      client_secret: 'client-secret',
      redirect_uri: redirectUri,
      code_verifier: expect.any(String),
    })
    expect(Object.keys(credentials).sort()).toEqual(['accessToken', 'apiDomain'])
    expect(revealSecret(credentials.accessToken)).toBe('access-token')
    expect(credentials.apiDomain).toBe('https://www.zohoapis.example')
  })

  test.each([
    'http://www.zohoapis.example',
    'https://user:password@www.zohoapis.example',
    'https://www.zohoapis.example/path',
    'https://www.zohoapis.example?query=value',
    'not a URL',
  ])('does not authorize an untrusted API domain returned by Zoho: %s', async (apiDomain) => {
    const fetch = vi.fn<TestFetch>(async () =>
      Response.json(tokenResponse({ api_domain: apiDomain })),
    )
    vi.stubGlobal('fetch', fetch)
    await expect(authorize()).rejects.toMatchObject({
      _tag: 'AuthorizationFailure',
      reason: 'ProviderFailure',
    })
    expect(fetch).toHaveBeenCalledOnce()
  })

  test('rejects an otherwise usable successful response larger than one MiB', async () => {
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

  test('rejects invalid UTF-8 rather than returning replacement characters in a credential', async () => {
    const prefix = new TextEncoder().encode('{"access_token":"')
    const suffix = new TextEncoder().encode(
      '","refresh_token":"refresh-token","api_domain":"https://www.zohoapis.example","token_type":"Bearer","expires_in":3600}',
    )
    const bytes = new Uint8Array(prefix.length + 1 + suffix.length)
    bytes.set(prefix)
    bytes[prefix.length] = 0xff
    bytes.set(suffix, prefix.length + 1)
    vi.stubGlobal(
      'fetch',
      vi.fn<TestFetch>(async () => new Response(bytes)),
    )
    await expect(authorize()).rejects.toMatchObject({
      _tag: 'AuthorizationFailure',
      reason: 'ProviderFailure',
    })
  })

  test('renews with a form POST and reuses an omitted refresh token on subsequent renewal', async () => {
    const fetch = vi
      .fn<TestFetch>()
      .mockResolvedValueOnce(Response.json(tokenResponse()))
      .mockImplementation(async () =>
        Response.json(
          tokenResponse({
            access_token: 'refreshed-access-token',
            refresh_token: undefined,
            api_domain: 'https://www.zohoapis.eu.example',
            expires_in: 1_800,
          }),
        ),
      )
    vi.stubGlobal('fetch', fetch)
    const configured = manager()
    await authorize(configured)
    await (await configured.credentialUse('connection')).reportRejected()
    const refreshed = await configured.credentialUse('connection')
    expect(revealSecret(refreshed.credentials.accessToken)).toBe('refreshed-access-token')
    expect(refreshed.credentials.apiDomain).toBe('https://www.zohoapis.eu.example')
    await refreshed.reportRejected()
    expect(revealSecret((await configured.credentials('connection')).accessToken)).toBe(
      'refreshed-access-token',
    )
    expect(fetch).toHaveBeenCalledTimes(3)
    for (const [url, request] of fetch.mock.calls.slice(1)) {
      expect(String(url)).toBe(`${accountsOrigin}/oauth/v2/token`)
      expect(request?.method).toBe('POST')
      expect(Object.fromEntries(new URLSearchParams(String(request?.body)))).toEqual({
        grant_type: 'refresh_token',
        client_id: 'client-id',
        client_secret: 'client-secret',
        refresh_token: 'refresh-token',
      })
    }
  })

  test('retains a confirmed refresh rejection as authorization required without replay', async () => {
    const fetch = vi
      .fn<TestFetch>()
      .mockResolvedValueOnce(Response.json(tokenResponse()))
      .mockResolvedValue(new Response('{"error":"invalid_code"}', { status: 400 }))
    vi.stubGlobal('fetch', fetch)
    const configured = manager()
    await authorize(configured)
    await (await configured.credentialUse('connection')).reportRejected()
    await expect(configured.credentials('connection')).rejects.toMatchObject({
      _tag: 'AuthorizationRequired',
    })
    await expect(configured.credentials('connection')).rejects.toMatchObject({
      _tag: 'AuthorizationRequired',
    })
    expect(fetch).toHaveBeenCalledTimes(2)
  })

  test('rejects an untrusted accounts URL before contacting Zoho', async () => {
    const fetch = vi.fn<TestFetch>()
    vi.stubGlobal('fetch', fetch)
    await expect(
      authorize(manager({ accountsOrigin: `${accountsOrigin}/tenant-selected` })),
    ).rejects.toMatchObject({ _tag: 'AuthorizationFailure', reason: 'ProviderFailure' })
    expect(fetch).not.toHaveBeenCalled()
  })
})

describe('Zoho Self Client', () => {
  test('keeps Self Client and browser OAuth credentials independent in the same store', async () => {
    const fetch = vi
      .fn<TestFetch>()
      .mockResolvedValueOnce(Response.json(tokenResponse({ access_token: 'browser-token' })))
      .mockResolvedValueOnce(Response.json(tokenResponse({ access_token: 'self-token' })))
    vi.stubGlobal('fetch', fetch)
    const shared = store()
    const browser = manager({}, shared)
    const self = selfClient({}, shared)
    await authorize(browser)
    await enroll(self)
    expect(revealSecret((await browser.credentials('connection')).accessToken)).toBe(
      'browser-token',
    )
    expect(revealSecret((await self.credentials('connection')).accessToken)).toBe('self-token')
  })

  test('supports one-use code enrollment without exposing browser authorization operations', () => {
    const configured = selfClient()
    expect(configured.enrollCode).toBeTypeOf('function')
    expect(configured).not.toHaveProperty('startAuthorization')
    expect(configured).not.toHaveProperty('completeAuthorization')
  })

  test('resolves lazy configuration only when exchanging an approved Self Client code', async () => {
    const clientId = vi.fn<() => string>(() => 'client-id')
    const clientSecret = vi.fn<() => string>(() => 'client-secret')
    const regionalOrigin = vi.fn<() => string>(() => 'https://accounts.zoho.eu.example')
    const fetch = vi.fn<TestFetch>(async () => Response.json(tokenResponse()))
    vi.stubGlobal('fetch', fetch)
    const configured = selfClient({ clientId, clientSecret, accountsOrigin: regionalOrigin })
    expect(clientId).not.toHaveBeenCalled()
    expect(clientSecret).not.toHaveBeenCalled()
    expect(regionalOrigin).not.toHaveBeenCalled()
    expect(fetch).not.toHaveBeenCalled()
    await enroll(configured)
    expect(revealSecret((await configured.credentials('connection')).accessToken)).toBe(
      'access-token',
    )
    expect(String(fetch.mock.calls[0]?.[0])).toBe('https://accounts.zoho.eu.example/oauth/v2/token')
    expect(new URLSearchParams(String(fetch.mock.calls[0]?.[1]?.body)).get('client_secret')).toBe(
      'client-secret',
    )
  })

  test('exchanges only Self Client parameters at the configured region and returns only use credentials', async () => {
    const fetch = vi.fn<TestFetch>(async () => Response.json(tokenResponse()))
    vi.stubGlobal('fetch', fetch)
    const configured = selfClient({ accountsOrigin: 'https://accounts.zoho.eu.example' })
    await enroll(configured)
    const [url, request] = fetch.mock.calls[0]!
    expect(String(url)).toBe('https://accounts.zoho.eu.example/oauth/v2/token')
    expect(request).toMatchObject({ method: 'POST', redirect: 'error' })
    expect(new Headers(request?.headers).get('content-type')).toBe(
      'application/x-www-form-urlencoded',
    )
    expect(Object.fromEntries(new URLSearchParams(String(request?.body)))).toEqual({
      grant_type: 'authorization_code',
      code: 'one-time-code',
      client_id: 'client-id',
      client_secret: 'client-secret',
    })
    const credentials = await configured.credentials('connection')
    expect(Object.keys(credentials).sort()).toEqual(['accessToken', 'apiDomain'])
    expect(revealSecret(credentials.accessToken)).toBe('access-token')
    expect(credentials.apiDomain).toBe('https://www.zohoapis.example')
    for (const secret of ['refresh-token', 'client-secret', 'one-time-code']) {
      expect(JSON.stringify(credentials)).not.toContain(secret)
    }
  })

  test('renews Self Client credentials without exposing or losing the saved refresh token', async () => {
    const fetch = vi
      .fn<TestFetch>()
      .mockResolvedValueOnce(Response.json(tokenResponse()))
      .mockImplementation(async () =>
        Response.json(tokenResponse({ access_token: 'refreshed', refresh_token: undefined })),
      )
    vi.stubGlobal('fetch', fetch)
    const configured = selfClient()
    await enroll(configured)
    await (await configured.credentialUse('connection')).reportRejected()
    const renewed = await configured.credentialUse('connection')
    expect(revealSecret(renewed.credentials.accessToken)).toBe('refreshed')
    expect(Object.keys(renewed.credentials).sort()).toEqual(['accessToken', 'apiDomain'])
    await renewed.reportRejected()
    expect(revealSecret((await configured.credentials('connection')).accessToken)).toBe('refreshed')
    expect(fetch).toHaveBeenCalledTimes(3)
    for (const [, request] of fetch.mock.calls.slice(1)) {
      expect(new URLSearchParams(String(request?.body)).get('refresh_token')).toBe('refresh-token')
    }
  })

  test('rejects an invalid Accounts origin without dispatch or secret disclosure', async () => {
    const fetch = vi.fn<TestFetch>()
    vi.stubGlobal('fetch', fetch)
    const failure = await enroll(
      selfClient({ accountsOrigin: 'https://user:password@accounts.zoho.example/tenant' }),
    ).catch((error: unknown) => error)
    expect(failure).toMatchObject({ _tag: 'AuthorizationFailure', reason: 'ProviderFailure' })
    expect(JSON.stringify(failure)).not.toContain('one-time-code')
    expect(JSON.stringify(failure)).not.toContain('client-secret')
    expect(fetch).not.toHaveBeenCalled()
  })

  test('returns a safe authorization rejection without echoing the code or provider details', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn<TestFetch>(async () =>
        Response.json(
          {
            error: 'invalid_code',
            detail: 'one-time-code client-secret',
          },
          { status: 400 },
        ),
      ),
    )
    const failure = await enroll(selfClient()).catch((error: unknown) => error)
    expect(failure).toMatchObject({ _tag: 'AuthorizationFailure', reason: 'ProviderRejected' })
    for (const secret of ['one-time-code', 'client-secret', 'invalid_code'])
      expect(JSON.stringify(failure)).not.toContain(secret)
  })

  test.each([408, 429, 500, 503])(
    'retains uncertainty after a one-use code exchange returns HTTP %i',
    async (status) => {
      const fetch = vi.fn<TestFetch>(async () => new Response(null, { status }))
      vi.stubGlobal('fetch', fetch)
      const configured = selfClient()
      await expect(enroll(configured)).rejects.toMatchObject({
        _tag: 'AuthorizationFailure',
        reason: 'InterventionRequired',
      })
      expect(await configured.inspect('connection')).toEqual({
        savedAuthorization: false,
        credentialWork: 'intervention-required',
      })
      expect(fetch).toHaveBeenCalledOnce()
    },
  )

  test('keeps transport and malformed-response failures secret-safe', async () => {
    const fetch = vi
      .fn<TestFetch>()
      .mockRejectedValueOnce(new Error('one-time-code client-secret'))
      .mockResolvedValueOnce(Response.json({ access_token: 'one-time-code' }))
    vi.stubGlobal('fetch', fetch)
    const transportFailure = await enroll(selfClient()).catch((error: unknown) => error)
    const malformedFailure = await enroll(selfClient()).catch((error: unknown) => error)
    expect(transportFailure).toMatchObject({ reason: 'InterventionRequired' })
    expect(malformedFailure).toMatchObject({ reason: 'InterventionRequired' })
    for (const failure of [transportFailure, malformedFailure]) {
      expect([String(failure), JSON.stringify(failure), inspect(failure)].join('\n')).not.toContain(
        'one-time-code',
      )
      expect([String(failure), JSON.stringify(failure), inspect(failure)].join('\n')).not.toContain(
        'client-secret',
      )
    }
  })
})
