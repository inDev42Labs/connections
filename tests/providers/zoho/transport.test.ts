import { Effect, Redacted } from 'effect'
import { afterEach, describe, expect, test, vi } from 'vitest'
import {
  Zoho,
  type ZohoOAuth,
  type ZohoSecret,
  type ZohoSelfClient,
  type ZohoText,
} from '../../../src/providers/zoho/index.js'

const accountsOrigin = 'https://accounts.zoho.example'
const redirectUri = 'https://app.example.test/oauth/zoho/callback'

type TestFetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>

interface TestProviderOptions {
  readonly clientId?: ZohoText
  readonly clientSecret?: ZohoSecret
  readonly redirectUri?: ZohoText
  readonly scopes?: readonly [string, ...string[]]
  readonly accountsOrigin?: ZohoText
}

function provider(overrides: TestProviderOptions = {}): ZohoOAuth {
  return Zoho.oauth({
    clientId: 'client-id',
    clientSecret: Effect.succeed(Redacted.make('client-secret')),
    redirectUri,
    scopes: ['ZohoCRM.modules.ALL', 'ZohoCRM.settings.ALL'],
    accountsOrigin,
    ...overrides,
  })
}

function exchangeWith(
  zoho: ZohoOAuth,
  overrides: Partial<Parameters<ReturnType<typeof provider>['exchangeAuthorizationCode']>[0]> = {},
) {
  return zoho.exchangeAuthorizationCode({
    code: Redacted.make('authorization-code'),
    codeVerifier: Redacted.make('pkce-verifier'),
    now: 1_000,
    ...overrides,
  })
}

function exchange(
  overrides: Partial<Parameters<ReturnType<typeof provider>['exchangeAuthorizationCode']>[0]> = {},
) {
  return exchangeWith(provider(), overrides)
}

interface SelfClientOptions {
  readonly clientId?: ZohoText
  readonly clientSecret?: ZohoSecret
  readonly accountsOrigin?: ZohoText
}

function selfClient(overrides: SelfClientOptions = {}): ZohoSelfClient {
  return Zoho.selfClient({
    clientId: 'client-id',
    clientSecret: Effect.succeed(Redacted.make('client-secret')),
    accountsOrigin,
    ...overrides,
  })
}

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

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('Zoho OAuth transport', () => {
  test('constructs lazily and builds the regional authorization URL with Zoho conventions', async () => {
    const clientIdAccess = vi.fn<() => string>(() => 'client-id')
    const secretAccess = vi.fn<() => Redacted.Redacted<string>>(() =>
      Redacted.make('client-secret'),
    )
    const accountsAccess = vi.fn<() => string>(() => accountsOrigin)
    const redirectAccess = vi.fn<() => string>(() => redirectUri)
    const fetchAccess = vi.fn<TestFetch>()
    vi.stubGlobal('fetch', fetchAccess)

    const zoho = provider({
      clientId: Effect.sync(clientIdAccess),
      clientSecret: Effect.sync(secretAccess),
      accountsOrigin: Effect.sync(accountsAccess),
      redirectUri: Effect.sync(redirectAccess),
    })

    expect(clientIdAccess).not.toHaveBeenCalled()
    expect(secretAccess).not.toHaveBeenCalled()
    expect(accountsAccess).not.toHaveBeenCalled()
    expect(redirectAccess).not.toHaveBeenCalled()
    expect(fetchAccess).not.toHaveBeenCalled()

    const value = await Effect.runPromise(
      zoho.authorizationUrl({ state: 'state-value', codeChallenge: 'pkce-challenge' }),
    )
    const url = new URL(value)

    expect(url.origin).toBe(accountsOrigin)
    expect(url.pathname).toBe('/oauth/v2/auth')
    expect(url.searchParams.get('response_type')).toBe('code')
    expect(url.searchParams.get('client_id')).toBe('client-id')
    expect(url.searchParams.get('redirect_uri')).toBe(redirectUri)
    expect(url.searchParams.get('scope')).toBe('ZohoCRM.modules.ALL,ZohoCRM.settings.ALL')
    expect(url.searchParams.get('access_type')).toBe('offline')
    expect(url.searchParams.get('state')).toBe('state-value')
    expect(url.searchParams.get('code_challenge')).toBe('pkce-challenge')
    expect(url.searchParams.get('code_challenge_method')).toBe('S256')
    expect(secretAccess).not.toHaveBeenCalled()
    expect(fetchAccess).not.toHaveBeenCalled()
  })

  test('supports plain and lazy browser OAuth configuration without resolving getters at construction', async () => {
    const clientId = vi.fn<() => string>(() => 'client-id')
    const clientSecret = vi.fn<() => string>(() => 'client-secret')
    const redirect = vi.fn<() => string>(() => redirectUri)
    const accounts = vi.fn<() => string>(() => accountsOrigin)
    const fetchMock = vi.fn<TestFetch>(() => Promise.resolve(Response.json(tokenResponse())))
    vi.stubGlobal('fetch', fetchMock)

    const lazyZoho = Zoho.oauth({
      clientId,
      clientSecret,
      redirectUri: redirect,
      scopes: ['ZohoCRM.modules.ALL'],
      accountsOrigin: accounts,
    })
    expect(clientId).not.toHaveBeenCalled()
    expect(clientSecret).not.toHaveBeenCalled()
    expect(redirect).not.toHaveBeenCalled()
    expect(accounts).not.toHaveBeenCalled()
    expect(fetchMock).not.toHaveBeenCalled()

    await Effect.runPromise(exchangeWith(lazyZoho))
    expect(clientId).toHaveBeenCalledOnce()
    expect(clientSecret).toHaveBeenCalledOnce()
    expect(redirect).toHaveBeenCalledOnce()
    expect(accounts).toHaveBeenCalledOnce()
    const requestBody = fetchMock.mock.calls[0]?.[1]?.body
    expect(requestBody).toBeInstanceOf(URLSearchParams)
    expect((requestBody as URLSearchParams).get('client_secret')).toBe('client-secret')

    const plainZoho = Zoho.oauth({
      clientId: 'client-id',
      clientSecret: 'plain-client-secret',
      redirectUri,
      scopes: ['ZohoCRM.modules.ALL'],
      accountsOrigin,
    })
    await Effect.runPromise(exchangeWith(plainZoho))
    const plainBody = fetchMock.mock.calls[1]?.[1]?.body
    expect(plainBody).toBeInstanceOf(URLSearchParams)
    expect((plainBody as URLSearchParams).get('client_secret')).toBe('plain-client-secret')
  })

  test('maps missing or throwing configuration getters to safe invalid configuration failures', async () => {
    const fetchMock = vi.fn<TestFetch>()
    vi.stubGlobal('fetch', fetchMock)
    const missingSecret = provider({ clientSecret: () => undefined as unknown as string })
    const secretFailure = await Effect.runPromise(Effect.flip(exchangeWith(missingSecret)))
    expect(secretFailure).toMatchObject({ reason: 'InvalidConfiguration' })

    const secretInThrownError = 'do-not-leak-this-secret'
    const throwingAccountsOrigin = provider({
      accountsOrigin: () => {
        throw new Error(secretInThrownError)
      },
    })
    const accountsFailure = await Effect.runPromise(
      Effect.flip(exchangeWith(throwingAccountsOrigin)),
    )
    expect(accountsFailure).toMatchObject({ reason: 'InvalidConfiguration' })
    expect(JSON.stringify(accountsFailure)).not.toContain(secretInThrownError)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  test('copies scope configuration without freezing caller-owned input', () => {
    const mutableScopes: [string, ...string[]] = ['ZohoCRM.modules.ALL']

    const zoho = provider({ scopes: mutableScopes })
    mutableScopes.push('ZohoCRM.settings.ALL')

    expect(Object.isFrozen(mutableScopes)).toBe(false)
    expect(zoho.configuration.scopes).toEqual(['ZohoCRM.modules.ALL'])
  })

  test('parses only callbacks matching the configured redirect URI', async () => {
    const granted = await Effect.runPromise(
      provider().parseAuthorizationCallback(
        `${redirectUri}?code=authorization-code&state=state-value`,
      ),
    )

    expect(granted._tag).toBe('AuthorizationGranted')
    if (granted._tag !== 'AuthorizationGranted') throw new Error('Expected authorization grant')
    expect(granted.state).toBe('state-value')
    expect(Redacted.value(granted.code)).toBe('authorization-code')

    const failure = await Effect.runPromise(
      Effect.flip(
        provider().parseAuthorizationCallback(
          'https://attacker.example/oauth/zoho/callback?code=authorization-code&state=state-value',
        ),
      ),
    )
    expect(failure).toMatchObject({ reason: 'InvalidCallback' })
  })

  test('exchanges with a form POST at only the configured accounts origin and projects redacted credentials', async () => {
    const fetchMock = vi.fn<TestFetch>((_input, _init) =>
      Promise.resolve(Response.json(tokenResponse())),
    )
    vi.stubGlobal('fetch', fetchMock)

    const credentials = await Effect.runPromise(exchange())
    const request = fetchMock.mock.calls[0]
    expect(request).toBeDefined()
    const [input, init] = request!
    const url = new URL(String(input))
    const body = init?.body

    expect(url.toString()).toBe(`${accountsOrigin}/oauth/v2/token`)
    expect(url.search).toBe('')
    expect(init?.method).toBe('POST')
    expect(init?.redirect).toBe('error')
    expect(init?.headers).toEqual({
      'content-type': 'application/x-www-form-urlencoded',
    })
    expect(body).toBeInstanceOf(URLSearchParams)
    expect(Object.fromEntries((body as URLSearchParams).entries())).toEqual({
      grant_type: 'authorization_code',
      code: 'authorization-code',
      client_id: 'client-id',
      client_secret: 'client-secret',
      redirect_uri: redirectUri,
      code_verifier: 'pkce-verifier',
    })
    expect(credentials.credentialExpiresAt).toBe(3_601_000)

    const projected = await Effect.runPromise(
      provider().projectCredentials(credentials.protectedPayload),
    )
    expect(Object.keys(projected).sort()).toEqual(['accessToken', 'apiDomain'])
    expect(Redacted.value(projected.accessToken)).toBe('access-token')
    expect(projected.apiDomain).toBe('https://www.zohoapis.example')
  })

  test.each([
    'http://www.zohoapis.example',
    'https://user:password@www.zohoapis.example',
    'https://www.zohoapis.example/path',
    'https://www.zohoapis.example?query=value',
    'not a URL',
  ])('rejects an invalid api_domain: %s', async (apiDomain) => {
    vi.stubGlobal(
      'fetch',
      vi.fn<TestFetch>(() =>
        Promise.resolve(Response.json(tokenResponse({ api_domain: apiDomain }))),
      ),
    )

    const failure = await Effect.runPromise(Effect.flip(exchange()))

    expect(failure).toMatchObject({ reason: 'MalformedResponse' })
  })

  test('rejects a successful JSON response larger than one MiB', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn<TestFetch>(() =>
        Promise.resolve(new Response(new Uint8Array(1024 * 1024 + 1), { status: 200 })),
      ),
    )

    const failure = await Effect.runPromise(Effect.flip(exchange()))

    expect(failure).toMatchObject({ reason: 'MalformedResponse' })
  })

  test('rejects invalid UTF-8 instead of persisting replacement characters', async () => {
    const prefix = new TextEncoder().encode('{"access_token":"')
    const suffix = new TextEncoder().encode(
      '","refresh_token":"refresh-token","api_domain":"https://www.zohoapis.example","token_type":"Bearer","expires_in":3600}',
    )
    const body = new Uint8Array(prefix.length + 1 + suffix.length)
    body.set(prefix)
    body[prefix.length] = 0xff
    body.set(suffix, prefix.length + 1)
    vi.stubGlobal(
      'fetch',
      vi.fn<TestFetch>(() => Promise.resolve(new Response(body, { status: 200 }))),
    )

    const failure = await Effect.runPromise(Effect.flip(exchange()))

    expect(failure).toMatchObject({ reason: 'MalformedResponse' })
  })

  test('refreshes with a form POST and retains the reusable refresh token when omitted', async () => {
    const fetchMock = vi
      .fn<TestFetch>()
      .mockResolvedValueOnce(Response.json(tokenResponse()))
      .mockResolvedValueOnce(
        Response.json(
          tokenResponse({
            access_token: 'refreshed-access-token',
            refresh_token: undefined,
            api_domain: 'https://www.zohoapis.eu.example',
            expires_in: 1_800,
          }),
        ),
      )
    vi.stubGlobal('fetch', fetchMock)

    const initial = await Effect.runPromise(exchange())
    const outcome = await Effect.runPromise(
      provider().refreshCredentials({ protectedPayload: initial.protectedPayload, now: 5_000 }),
    )

    expect(outcome._tag).toBe('Refreshed')
    if (outcome._tag !== 'Refreshed') throw new Error('Expected refreshed credentials')

    const refreshRequest = fetchMock.mock.calls[1]
    expect(refreshRequest).toBeDefined()
    const [refreshInput, refreshInit] = refreshRequest!
    const refreshBody = refreshInit?.body
    expect(new URL(String(refreshInput)).toString()).toBe(`${accountsOrigin}/oauth/v2/token`)
    expect(refreshInit?.method).toBe('POST')
    expect(refreshInit?.redirect).toBe('error')
    expect(refreshBody).toBeInstanceOf(URLSearchParams)
    expect(Object.fromEntries((refreshBody as URLSearchParams).entries())).toEqual({
      grant_type: 'refresh_token',
      refresh_token: 'refresh-token',
      client_id: 'client-id',
      client_secret: 'client-secret',
    })
    expect(outcome.credentials.credentialExpiresAt).toBe(1_805_000)
    expect(JSON.parse(Redacted.value(outcome.credentials.protectedPayload))).toMatchObject({
      accessToken: 'refreshed-access-token',
      refreshToken: 'refresh-token',
      apiDomain: 'https://www.zohoapis.eu.example',
    })
  })

  test('maps a rejected refresh without exposing a typed failure', async () => {
    const fetchMock = vi
      .fn<TestFetch>()
      .mockResolvedValueOnce(Response.json(tokenResponse()))
      .mockResolvedValueOnce(new Response('{"error":"invalid_code"}', { status: 400 }))
    vi.stubGlobal('fetch', fetchMock)

    const initial = await Effect.runPromise(exchange())
    const outcome = await Effect.runPromise(
      provider().refreshCredentials({ protectedPayload: initial.protectedPayload, now: 5_000 }),
    )

    expect(outcome).toEqual({ _tag: 'ProviderRejected' })
  })

  test('rejects an untrusted accounts URL before fetching', async () => {
    const fetchMock = vi.fn<TestFetch>()
    vi.stubGlobal('fetch', fetchMock)

    const failure = await Effect.runPromise(
      Effect.flip(
        provider({
          accountsOrigin: 'https://accounts.zoho.example/tenant-selected',
        }).exchangeAuthorizationCode({
          code: Redacted.make('authorization-code'),
          codeVerifier: Redacted.make('pkce-verifier'),
          now: 1_000,
        }),
      ),
    )

    expect(failure).toMatchObject({ reason: 'InvalidConfiguration' })
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

describe('Zoho Self Client transport', () => {
  test('defines a distinct provider capability without browser configuration', () => {
    const self = selfClient()

    expect(self.id).toBe('zoho-self-client')
    expect(self.configuration).toEqual({
      clientId: 'client-id',
      clientSecret: expect.anything(),
      accountsOrigin,
    })
    expect(Object.keys(self.configuration).sort()).toEqual([
      'accountsOrigin',
      'clientId',
      'clientSecret',
    ])
    expect(self).not.toHaveProperty('authorizationUrl')
    expect(self).not.toHaveProperty('parseAuthorizationCallback')
  })

  test('resolves shared lazy configuration only for the Self Client exchange', async () => {
    const clientId = vi.fn<() => string>(() => 'client-id')
    const clientSecret = vi.fn<() => string>(() => 'client-secret')
    const regionalAccountsOrigin = vi.fn<() => string>(() => 'https://accounts.zoho.eu.example')
    const fetchMock = vi.fn<TestFetch>(() => Promise.resolve(Response.json(tokenResponse())))
    vi.stubGlobal('fetch', fetchMock)

    const self = Zoho.selfClient({ clientId, clientSecret, accountsOrigin: regionalAccountsOrigin })
    expect(clientId).not.toHaveBeenCalled()
    expect(clientSecret).not.toHaveBeenCalled()
    expect(regionalAccountsOrigin).not.toHaveBeenCalled()
    expect(fetchMock).not.toHaveBeenCalled()

    await Effect.runPromise(
      self.exchangeSelfClientCode({ code: Redacted.make('one-time-code'), now: 2_000 }),
    )

    expect(clientId).toHaveBeenCalledOnce()
    expect(clientSecret).toHaveBeenCalledOnce()
    expect(regionalAccountsOrigin).toHaveBeenCalledOnce()
    const body = fetchMock.mock.calls[0]?.[1]?.body
    expect(body).toBeInstanceOf(URLSearchParams)
    expect((body as URLSearchParams).get('client_secret')).toBe('client-secret')
  })

  test('exchanges a redacted one-time code at the configured Accounts origin with only Self Client parameters', async () => {
    const regionalAccountsOrigin = 'https://accounts.zoho.eu.example'
    const fetchMock = vi.fn<TestFetch>(() => Promise.resolve(Response.json(tokenResponse())))
    vi.stubGlobal('fetch', fetchMock)

    const self = selfClient({ accountsOrigin: regionalAccountsOrigin })
    const credentials = await Effect.runPromise(
      self.exchangeSelfClientCode({ code: Redacted.make('one-time-code'), now: 2_000 }),
    )

    const request = fetchMock.mock.calls[0]
    expect(request).toBeDefined()
    const [input, init] = request!
    expect(new URL(String(input)).toString()).toBe(`${regionalAccountsOrigin}/oauth/v2/token`)
    expect(init?.method).toBe('POST')
    expect(init?.redirect).toBe('error')
    expect(init?.headers).toEqual({
      'content-type': 'application/x-www-form-urlencoded',
    })
    const body = init?.body
    expect(body).toBeInstanceOf(URLSearchParams)
    expect(Object.fromEntries((body as URLSearchParams).entries())).toEqual({
      grant_type: 'authorization_code',
      client_id: 'client-id',
      client_secret: 'client-secret',
      code: 'one-time-code',
    })
    expect(credentials.credentialExpiresAt).toBe(3_602_000)

    const projected = await Effect.runPromise(self.projectCredentials(credentials.protectedPayload))
    expect(Object.keys(projected).sort()).toEqual(['accessToken', 'apiDomain'])
    expect(Redacted.value(projected.accessToken)).toBe('access-token')
    expect(JSON.stringify(projected)).not.toContain('refresh-token')
    expect(JSON.stringify(projected)).not.toContain('client-secret')
    expect(JSON.stringify(projected)).not.toContain('one-time-code')
  })

  test('reuses the Zoho refresh lifecycle and credential projection', async () => {
    const fetchMock = vi
      .fn<TestFetch>()
      .mockResolvedValueOnce(Response.json(tokenResponse()))
      .mockResolvedValueOnce(
        Response.json(
          tokenResponse({
            access_token: 'refreshed-access-token',
            refresh_token: undefined,
            expires_in: 1_800,
          }),
        ),
      )
    vi.stubGlobal('fetch', fetchMock)

    const self = selfClient()
    const initial = await Effect.runPromise(
      self.exchangeSelfClientCode({ code: Redacted.make('one-time-code'), now: 2_000 }),
    )
    const outcome = await Effect.runPromise(
      self.refreshCredentials({ protectedPayload: initial.protectedPayload, now: 5_000 }),
    )

    expect(outcome._tag).toBe('Refreshed')
    if (outcome._tag !== 'Refreshed') throw new Error('Expected refreshed credentials')
    expect(fetchMock).toHaveBeenCalledTimes(2)
    const refreshRequest = fetchMock.mock.calls[1]
    expect(refreshRequest).toBeDefined()
    const [input, init] = refreshRequest!
    expect(new URL(String(input)).toString()).toBe(`${accountsOrigin}/oauth/v2/token`)
    const refreshBody = init?.body
    expect(refreshBody).toBeInstanceOf(URLSearchParams)
    expect(Object.fromEntries((refreshBody as URLSearchParams).entries())).toEqual({
      grant_type: 'refresh_token',
      refresh_token: 'refresh-token',
      client_id: 'client-id',
      client_secret: 'client-secret',
    })

    const projected = await Effect.runPromise(
      self.projectCredentials(outcome.credentials.protectedPayload),
    )
    expect(Redacted.value(projected.accessToken)).toBe('refreshed-access-token')
    expect(projected.apiDomain).toBe('https://www.zohoapis.example')
  })

  test('rejects an invalid configured Accounts origin without making a request', async () => {
    const fetchMock = vi.fn<TestFetch>()
    vi.stubGlobal('fetch', fetchMock)

    const failure = await Effect.runPromise(
      Effect.flip(
        selfClient({
          accountsOrigin: 'https://user:password@accounts.zoho.example/tenant',
        }).exchangeSelfClientCode({ code: Redacted.make('one-time-code'), now: 1_000 }),
      ),
    )

    expect(failure).toMatchObject({ reason: 'InvalidConfiguration' })
    expect(JSON.stringify(failure)).not.toContain('one-time-code')
    expect(JSON.stringify(failure)).not.toContain('client-secret')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  test('returns redacted provider rejection details without echoing code or credentials', async () => {
    const fetchMock = vi.fn<TestFetch>(() =>
      Promise.resolve(
        Response.json(
          { error: 'invalid_code', detail: 'one-time-code client-secret' },
          { status: 400 },
        ),
      ),
    )
    vi.stubGlobal('fetch', fetchMock)

    const failure = await Effect.runPromise(
      Effect.flip(
        selfClient().exchangeSelfClientCode({ code: Redacted.make('one-time-code'), now: 1_000 }),
      ),
    )

    expect(failure).toMatchObject({ reason: 'ProviderRejected' })
    expect(JSON.stringify(failure)).not.toContain('one-time-code')
    expect(JSON.stringify(failure)).not.toContain('client-secret')
    expect(JSON.stringify(failure)).not.toContain('invalid_code')
  })

  test.each([408, 429, 500, 503])(
    'treats HTTP %i from one-time code exchange as an uncertain outcome',
    async (status) => {
      const fetchMock = vi.fn<TestFetch>(() => Promise.resolve(new Response(null, { status })))
      vi.stubGlobal('fetch', fetchMock)

      const failure = await Effect.runPromise(
        Effect.flip(
          selfClient().exchangeSelfClientCode({ code: Redacted.make('one-time-code'), now: 1_000 }),
        ),
      )

      expect(failure).toMatchObject({ reason: 'TransportFailure' })
      expect(fetchMock).toHaveBeenCalledTimes(1)
    },
  )

  test('sanitizes transport errors and malformed provider responses', async () => {
    const fetchMock = vi
      .fn<TestFetch>()
      .mockRejectedValueOnce(new Error('one-time-code client-secret'))
      .mockResolvedValueOnce(Response.json({ access_token: 'one-time-code' }))
    vi.stubGlobal('fetch', fetchMock)

    const transportFailure = await Effect.runPromise(
      Effect.flip(
        selfClient().exchangeSelfClientCode({ code: Redacted.make('one-time-code'), now: 1_000 }),
      ),
    )
    const malformedFailure = await Effect.runPromise(
      Effect.flip(
        selfClient().exchangeSelfClientCode({ code: Redacted.make('one-time-code'), now: 1_000 }),
      ),
    )

    expect(transportFailure).toMatchObject({ reason: 'TransportFailure' })
    expect(malformedFailure).toMatchObject({ reason: 'MalformedResponse' })
    for (const failure of [transportFailure, malformedFailure]) {
      expect(JSON.stringify(failure)).not.toContain('one-time-code')
      expect(JSON.stringify(failure)).not.toContain('client-secret')
    }
  })
})
