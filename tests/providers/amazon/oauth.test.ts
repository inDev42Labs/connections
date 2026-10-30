import { Effect, Redacted } from 'effect'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { Connections, revealSecret } from '../../../src/index.js'
import { Amazon, type AmazonOAuth } from '../../../src/providers/amazon/index.js'
import { Memory } from '../../../src/stores/memory/index.js'

const redirectUri = 'https://app.example.test/oauth/amazon/callback'
const binding = 'trusted-session'
const key = 'AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE='

type TestFetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>

function tokenResponse(overrides: Record<string, unknown> = {}) {
  return {
    access_token: 'amazon-access-token',
    refresh_token: 'amazon-refresh-token',
    token_type: 'bearer',
    expires_in: 3600,
    ...overrides,
  }
}

function manager(overrides: Partial<AmazonOAuth['configuration']> = {}) {
  return Connections.create({
    store: Memory.store({ encryptionKey: key }),
    provider: Amazon.oauth({
      clientId: () => 'client-id',
      clientSecret: () => 'client-secret',
      redirectUri,
      scopes: ['advertising::campaign_management'],
      ...overrides,
    }),
  })
}

function callback(state: string, extra: Record<string, string> = {}) {
  const url = new URL(redirectUri)
  url.search = new URLSearchParams({ code: 'authorization-code', state, ...extra }).toString()
  return url.toString()
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

async function enroll(amazon = manager()) {
  const start = await amazon.startAuthorization('connection', { binding })
  const state = new URL(start.url).searchParams.get('state')!
  await amazon.completeAuthorization({
    callbackUrl: callback(state),
    binding,
    authorize: () => undefined,
  })
  return amazon
}

describe('Amazon Login with Amazon OAuth', () => {
  test.each([
    { clientId: '' },
    { clientId: () => undefined as unknown as string },
    {
      clientId: () => {
        throw new Error('secret-configuration-error')
      },
    },
    { redirectUri: 'http://app.example.test/callback' },
    { redirectUri: 'https://user:password@app.example.test/callback' },
    { redirectUri: 'https://app.example.test/callback#fragment' },
    { redirectUri: `${redirectUri}?state=reserved` },
    { scopes: [''] as const },
  ])('rejects invalid configuration before a request: %j', async (configuration) => {
    const fetchMock = vi.fn<TestFetch>()
    vi.stubGlobal('fetch', fetchMock)
    const failure = await manager(configuration)
      .startAuthorization('connection', { binding })
      .catch((error: unknown) => error)
    expect(failure).toMatchObject({ reason: 'ProviderFailure' })
    expect(JSON.stringify(failure)).not.toContain('secret-configuration-error')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  test('supports Effect configuration and verifies configured callback query parameters', async () => {
    const fetchMock = vi.fn<TestFetch>(() => Promise.resolve(Response.json(tokenResponse())))
    vi.stubGlobal('fetch', fetchMock)
    const amazon = manager({
      clientId: Effect.succeed('client-id'),
      clientSecret: Effect.succeed(Redacted.make('client-secret')),
      redirectUri: Effect.succeed(`${redirectUri}?context=trusted`),
    })
    const start = await amazon.startAuthorization('connection', { binding })
    const state = new URL(start.url).searchParams.get('state')!
    await expect(
      amazon.completeAuthorization({
        callbackUrl: callback(state, { context: 'untrusted' }),
        binding,
        authorize: () => undefined,
      }),
    ).rejects.toMatchObject({ reason: 'InvalidCallback' })
    expect(fetchMock).not.toHaveBeenCalled()
    await amazon.completeAuthorization({
      callbackUrl: callback(state, {
        context: 'trusted',
        scope: 'advertising::campaign_management',
      }),
      binding,
      authorize: () => undefined,
    })
    expect(revealSecret((await amazon.credentials('connection')).accessToken)).toBe(
      'amazon-access-token',
    )
  })

  test('does not expose a secret configuration failure or dispatch an exchange', async () => {
    const fetchMock = vi.fn<TestFetch>()
    vi.stubGlobal('fetch', fetchMock)
    const amazon = manager({
      clientSecret: () => {
        throw new Error('secret-client-configuration')
      },
    })
    const failure = await enroll(amazon).catch((error: unknown) => error)
    expect(failure).toMatchObject({ reason: 'ProviderFailure' })
    expect(JSON.stringify(failure)).not.toContain('secret-client-configuration')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  test.each([
    { access_token: '' },
    { access_token: undefined },
    { refresh_token: '' },
    { refresh_token: undefined },
    { token_type: 'mac' },
    { expires_in: undefined },
    { expires_in: null },
    { expires_in: 0 },
    { expires_in: -1 },
    { expires_in: '3600' },
    { expires_in: Number.MAX_VALUE },
  ])('rejects malformed enrollment token fields: %j', async (fields) => {
    const fetchMock = vi.fn<TestFetch>(() => Promise.resolve(Response.json(tokenResponse(fields))))
    vi.stubGlobal('fetch', fetchMock)
    const amazon = manager()
    const start = await amazon.startAuthorization('connection', { binding })
    const input = {
      callbackUrl: callback(new URL(start.url).searchParams.get('state')!),
      binding,
      authorize: () => undefined,
    }
    await expect(amazon.completeAuthorization(input)).rejects.toMatchObject({
      reason: 'ProviderFailure',
    })
    await expect(amazon.completeAuthorization(input)).rejects.toBeDefined()
    await expect(amazon.credentials('connection')).rejects.toBeDefined()
    expect(fetchMock).toHaveBeenCalledOnce()
  })

  test.each([
    [
      'wrong origin',
      (url: URL) => {
        url.hostname = 'attacker.example.test'
      },
    ],
    [
      'wrong path',
      (url: URL) => {
        url.pathname = '/wrong'
      },
    ],
    [
      'duplicate code',
      (url: URL) => {
        url.searchParams.append('code', 'other-code')
      },
    ],
    [
      'duplicate state',
      (url: URL) => {
        url.searchParams.append('state', 'other-state')
      },
    ],
    [
      'code and error',
      (url: URL) => {
        url.searchParams.set('error', 'access_denied')
      },
    ],
    [
      'missing code',
      (url: URL) => {
        url.searchParams.delete('code')
      },
    ],
    [
      'empty code',
      (url: URL) => {
        url.searchParams.set('code', '')
      },
    ],
    [
      'fragment',
      (url: URL) => {
        url.hash = '#code=hidden'
      },
    ],
  ] as const)('rejects a callback with %s before exchange', async (_label, mutate) => {
    const fetchMock = vi.fn<TestFetch>()
    vi.stubGlobal('fetch', fetchMock)
    const amazon = manager()
    const start = await amazon.startAuthorization('connection', { binding })
    const url = new URL(callback(new URL(start.url).searchParams.get('state')!))
    mutate(url)
    await expect(
      amazon.completeAuthorization({
        callbackUrl: url.toString(),
        binding,
        authorize: () => undefined,
      }),
    ).rejects.toMatchObject({ reason: 'InvalidCallback' })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  test('checks binding and application permission, prevents callback replay, and replaces deliberately', async () => {
    const fetchMock = vi
      .fn<TestFetch>()
      .mockResolvedValueOnce(Response.json(tokenResponse()))
      .mockResolvedValueOnce(Response.json(tokenResponse({ access_token: 'replacement-token' })))
    vi.stubGlobal('fetch', fetchMock)
    const amazon = manager()
    const start = await amazon.startAuthorization('connection', { binding })
    const callbackUrl = callback(new URL(start.url).searchParams.get('state')!)
    const authorize = vi.fn<() => void>(() => undefined)
    await expect(
      amazon.completeAuthorization({ callbackUrl, binding: 'wrong-session', authorize }),
    ).rejects.toMatchObject({ reason: 'InvalidAttempt' })
    expect(authorize).not.toHaveBeenCalled()
    const denied = new Error('Application denied access')
    await expect(
      amazon.completeAuthorization({
        callbackUrl,
        binding,
        authorize: () => {
          throw denied
        },
      }),
    ).rejects.toBe(denied)
    expect(fetchMock).not.toHaveBeenCalled()
    await amazon.completeAuthorization({ callbackUrl, binding, authorize })
    await expect(
      amazon.completeAuthorization({ callbackUrl, binding, authorize }),
    ).rejects.toMatchObject({ reason: 'InvalidAttempt' })
    expect(fetchMock).toHaveBeenCalledOnce()
    await expect(amazon.startAuthorization('connection', { binding })).rejects.toMatchObject({
      reason: 'Conflict',
    })
    const replacement = await amazon.startAuthorization('connection', { binding, replace: true })
    expect(revealSecret((await amazon.credentials('connection')).accessToken)).toBe(
      'amazon-access-token',
    )
    await amazon.completeAuthorization({
      callbackUrl: callback(new URL(replacement.url).searchParams.get('state')!),
      binding,
      authorize: (target) => {
        expect(target.intent).toBe('replace')
      },
    })
    expect(revealSecret((await amazon.credentials('connection')).accessToken)).toBe(
      'replacement-token',
    )
    await amazon.remove('connection')
    await expect(amazon.credentials('connection')).rejects.toMatchObject({
      _tag: 'AuthorizationRequired',
    })
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  test('handles Amazon authorization denial without a token request', async () => {
    const fetchMock = vi.fn<TestFetch>()
    vi.stubGlobal('fetch', fetchMock)
    const amazon = manager()
    const start = await amazon.startAuthorization('connection', { binding })
    const url = new URL(callback(new URL(start.url).searchParams.get('state')!))
    url.searchParams.delete('code')
    url.searchParams.set('error', 'access_denied')
    url.searchParams.set('error_description', 'secret-provider-description')
    const failure = await amazon
      .completeAuthorization({ callbackUrl: url.toString(), binding, authorize: () => undefined })
      .catch((error: unknown) => error)
    expect(failure).toMatchObject({ reason: 'ProviderDenied' })
    expect(JSON.stringify(failure)).not.toContain('secret-provider-description')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  test.each(['lost response', 'invalid JSON', 'invalid token'] as const)(
    'requires intervention after a refresh with %s and does not replay',
    async (scenario) => {
      const fetchMock = vi.fn<TestFetch>().mockResolvedValueOnce(Response.json(tokenResponse()))
      if (scenario === 'lost response')
        fetchMock.mockRejectedValue(new Error('secret-transport-error'))
      else if (scenario === 'invalid JSON')
        fetchMock.mockResolvedValue(new Response('{secret-response'))
      else fetchMock.mockResolvedValue(Response.json(tokenResponse({ refresh_token: '' })))
      vi.stubGlobal('fetch', fetchMock)
      const amazon = await enroll()
      const use = await amazon.credentialUse('connection')
      await use.reportRejected()
      const failure = await amazon.credentials('connection').catch((error: unknown) => error)
      expect(failure).toMatchObject({ _tag: 'InterventionRequired' })
      expect(JSON.stringify(failure)).not.toContain('secret-')
      await expect(amazon.credentials('connection')).rejects.toMatchObject({
        _tag: 'InterventionRequired',
      })
      expect(fetchMock).toHaveBeenCalledTimes(2)
    },
  )

  test('recovers after repairing a refresh configuration failure proven to precede dispatch', async () => {
    let clientSecret = 'client-secret'
    const fetchMock = vi
      .fn<TestFetch>()
      .mockResolvedValueOnce(Response.json(tokenResponse()))
      .mockResolvedValueOnce(Response.json(tokenResponse({ access_token: 'recovered-token' })))
    vi.stubGlobal('fetch', fetchMock)
    const amazon = await enroll(manager({ clientSecret: () => clientSecret }))
    const use = await amazon.credentialUse('connection')
    await use.reportRejected()
    clientSecret = ''
    await expect(amazon.credentials('connection')).rejects.toMatchObject({
      _tag: 'TemporarilyUnavailable',
    })
    expect(fetchMock).toHaveBeenCalledOnce()
    clientSecret = 'repaired-client-secret'
    expect(revealSecret((await amazon.credentials('connection')).accessToken)).toBe(
      'recovered-token',
    )
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  test.each([
    [400, 'invalid_grant', 'AuthorizationRequired'],
    [401, 'invalid_grant', 'AuthorizationRequired'],
    [400, 'invalid_client', 'TemporarilyUnavailable'],
    [401, 'invalid_client', 'TemporarilyUnavailable'],
    [429, 'slow_down', 'TemporarilyUnavailable'],
    [500, 'invalid_grant', 'TemporarilyUnavailable'],
  ] as const)(
    'classifies refresh HTTP %s %s as %s without replay',
    async (status, error, category) => {
      const fetchMock = vi
        .fn<TestFetch>()
        .mockResolvedValueOnce(Response.json(tokenResponse()))
        .mockResolvedValue(
          Response.json({ error, error_description: 'secret-error-description' }, { status }),
        )
      vi.stubGlobal('fetch', fetchMock)
      const amazon = await enroll()
      const use = await amazon.credentialUse('connection')
      await use.reportRejected()
      const failure = await amazon.credentials('connection').catch((error: unknown) => error)
      expect(failure).toMatchObject({ _tag: category })
      expect(JSON.stringify(failure)).not.toContain('secret-error-description')
      await expect(amazon.credentials('connection')).rejects.toMatchObject({ _tag: category })
      expect(fetchMock).toHaveBeenCalledTimes(2)
    },
  )

  test.each([
    ['na', 'https://www.amazon.com/ap/oa', 'https://api.amazon.com/auth/o2/token'],
    ['eu', 'https://eu.account.amazon.com/ap/oa', 'https://api.amazon.co.uk/auth/o2/token'],
    ['fe', 'https://apac.account.amazon.com/ap/oa', 'https://api.amazon.co.jp/auth/o2/token'],
  ] as const)(
    'uses documented %s endpoints with non-advertising scopes',
    async (region, authorizationUrl, tokenUrl) => {
      const clientId = vi.fn<() => string>(() => 'client-id')
      const secret = vi.fn<() => string>(() => 'client-secret')
      const redirect = vi.fn<() => string>(() => redirectUri)
      const fetchMock = vi.fn<TestFetch>(() => Promise.resolve(Response.json(tokenResponse())))
      vi.stubGlobal('fetch', fetchMock)
      const scopes: [string, ...string[]] = ['profile', 'postal_code']
      const provider = Amazon.oauth({
        clientId,
        clientSecret: secret,
        redirectUri: redirect,
        scopes,
        region,
      })
      scopes.push('unrequested-scope')
      const amazon = Connections.create({ store: Memory.store({ encryptionKey: key }), provider })
      expect(clientId).not.toHaveBeenCalled()
      expect(secret).not.toHaveBeenCalled()
      expect(redirect).not.toHaveBeenCalled()
      const start = await amazon.startAuthorization('connection', { binding })
      const url = new URL(start.url)
      expect(url.origin + url.pathname).toBe(authorizationUrl)
      expect(url.searchParams.get('scope')).toBe('profile postal_code')
      expect(secret).not.toHaveBeenCalled()
      await amazon.completeAuthorization({
        callbackUrl: callback(url.searchParams.get('state')!),
        binding,
        authorize: () => undefined,
      })
      const use = await amazon.credentialUse('connection')
      await use.reportRejected()
      await amazon.credentials('connection')
      expect(fetchMock.mock.calls.map(([endpoint]) => String(endpoint))).toEqual([
        tokenUrl,
        tokenUrl,
      ])
    },
  )

  test('renews expired credentials once and retains an omitted refresh token', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'))
    const fetchMock = vi
      .fn<TestFetch>()
      .mockResolvedValueOnce(Response.json(tokenResponse()))
      .mockResolvedValueOnce(
        Response.json(tokenResponse({ access_token: 'renewed-token', refresh_token: undefined })),
      )
      .mockResolvedValueOnce(
        Response.json(
          tokenResponse({
            access_token: 'reacquired-token',
            refresh_token: 'replacement-refresh-token',
          }),
        ),
      )
      .mockResolvedValueOnce(
        Response.json(tokenResponse({ access_token: 'rotated-token', refresh_token: undefined })),
      )
    vi.stubGlobal('fetch', fetchMock)
    const amazon = await enroll()
    vi.setSystemTime(new Date('2026-01-01T01:00:01Z'))
    const [first, second] = await Promise.all([
      amazon.credentials('connection'),
      Effect.runPromise(amazon.effect.credentials('connection')),
    ])
    expect(revealSecret(first.accessToken)).toBe('renewed-token')
    expect(revealSecret(second.accessToken)).toBe('renewed-token')
    expect(fetchMock).toHaveBeenCalledTimes(2)
    const use = await amazon.credentialUse('connection')
    await use.reportRejected()
    expect(revealSecret((await amazon.credentials('connection')).accessToken)).toBe(
      'reacquired-token',
    )
    const rotatedUse = await amazon.credentialUse('connection')
    await rotatedUse.reportRejected()
    expect(revealSecret((await amazon.credentials('connection')).accessToken)).toBe('rotated-token')
    const bodies = fetchMock.mock.calls
      .slice(1)
      .map(([, request]) =>
        Object.fromEntries(new URLSearchParams(request?.body as URLSearchParams)),
      )
    expect(bodies).toEqual([
      {
        grant_type: 'refresh_token',
        client_id: 'client-id',
        client_secret: 'client-secret',
        refresh_token: 'amazon-refresh-token',
      },
      {
        grant_type: 'refresh_token',
        client_id: 'client-id',
        client_secret: 'client-secret',
        refresh_token: 'amazon-refresh-token',
      },
      {
        grant_type: 'refresh_token',
        client_id: 'client-id',
        client_secret: 'client-secret',
        refresh_token: 'replacement-refresh-token',
      },
    ])
  })

  test('authorizes through the public manager and returns only a redacted access token', async () => {
    const fetchMock = vi.fn<TestFetch>(() => Promise.resolve(Response.json(tokenResponse())))
    vi.stubGlobal('fetch', fetchMock)
    const amazon = manager()
    expect(fetchMock).not.toHaveBeenCalled()

    const start = await amazon.startAuthorization('connection', { binding })
    const url = new URL(start.url)
    expect(url.origin + url.pathname).toBe('https://www.amazon.com/ap/oa')
    expect(url.searchParams.get('client_id')).toBe('client-id')
    expect(url.searchParams.get('scope')).toBe('advertising::campaign_management')
    expect(url.searchParams.get('response_type')).toBe('code')
    expect(url.searchParams.get('redirect_uri')).toBe(redirectUri)
    expect(url.searchParams.get('code_challenge_method')).toBe('S256')
    expect(url.searchParams.get('code_challenge')).toMatch(/^[A-Za-z0-9_-]{43}$/)
    const state = url.searchParams.get('state')!
    expect(state.length).toBeGreaterThan(0)
    expect(fetchMock).not.toHaveBeenCalled()

    await expect(
      amazon.completeAuthorization({
        callbackUrl: callback(state, { scope: 'advertising::campaign_management' }),
        binding,
        authorize: ({ connectionId, intent }) => {
          expect({ connectionId, intent }).toEqual({ connectionId: 'connection', intent: 'enroll' })
          expect(fetchMock).not.toHaveBeenCalled()
        },
      }),
    ).resolves.toEqual({ connectionId: 'connection' })
    const credentials = await amazon.credentials('connection')
    expect(Object.keys(credentials)).toEqual(['accessToken'])
    expect(revealSecret(credentials.accessToken)).toBe('amazon-access-token')
    expect(JSON.stringify(credentials)).not.toContain('amazon-access-token')
    expect(JSON.stringify(await amazon.inspect('connection'))).not.toContain('amazon-')
    const effectCredentials = await Effect.runPromise(amazon.effect.credentials('connection'))
    expect(revealSecret(effectCredentials.accessToken)).toBe('amazon-access-token')

    expect(fetchMock).toHaveBeenCalledOnce()
    const [endpoint, request] = fetchMock.mock.calls[0]!
    expect(String(endpoint)).toBe('https://api.amazon.com/auth/o2/token')
    expect(request?.method).toBe('POST')
    expect(request?.redirect).toBe('error')
    const body = new URLSearchParams(request?.body as URLSearchParams)
    expect(Object.fromEntries(body)).toMatchObject({
      grant_type: 'authorization_code',
      client_id: 'client-id',
      client_secret: 'client-secret',
      redirect_uri: redirectUri,
      code: 'authorization-code',
    })
    const verifier = body.get('code_verifier')!
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))
    expect(Buffer.from(digest).toString('base64url')).toBe(url.searchParams.get('code_challenge'))
  })
})
