import { inspect } from 'node:util'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { Connections, revealSecret } from '../../../src/index.js'
import { Salesforce, type SalesforceOAuth } from '../../../src/providers/salesforce/index.js'
import { Memory } from '../../../src/stores/memory/index.js'
import {
  startSalesforceServer,
  type SalesforceTestServer,
} from '../../fixtures/salesforce-server.js'

const servers = new Set<SalesforceTestServer>()
const redirectUri = 'https://app.example.test/oauth/callback'
type TestFetch = (...args: Parameters<typeof globalThis.fetch>) => Promise<Response>

function manager(options: Partial<SalesforceOAuth['configuration']> = {}) {
  return Connections.create({
    provider: Salesforce.oauth({
      clientId: 'client-id',
      clientSecret: 'client-secret',
      redirectUri,
      scopes: ['api', 'refresh_token'],
      ...options,
    }),
    store: Memory.store({ encryptionKey: 'KioqKioqKioqKioqKioqKioqKioqKioqKioqKioqKio=' }),
  })
}

async function authorize(configured = manager()) {
  const start = await configured.startAuthorization('connection', { binding: 'session' })
  const callback = new URL(redirectUri)
  callback.search = new URLSearchParams({
    code: 'authorization-code',
    state: new URL(start.url).searchParams.get('state')!,
  }).toString()
  await configured.completeAuthorization({
    callbackUrl: callback.toString(),
    binding: 'session',
    authorize: () => undefined,
  })
  return configured.credentials('connection')
}

function tokenResponse() {
  return {
    access_token: 'access-token',
    refresh_token: 'refresh-token',
    instance_url: 'https://instance.example.test',
    token_type: 'Bearer',
  }
}

afterEach(async () => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  await Promise.all([...servers].map((server) => server.close()))
  servers.clear()
})

describe('Salesforce browser OAuth HTTP behavior', () => {
  test('accepts plain and lazy configuration without accessing configuration during construction', async () => {
    const clientId = vi.fn<() => string>(() => 'client-id')
    const clientSecret = vi.fn<() => string>(() => 'client-secret')
    const redirect = vi.fn<() => string>(() => redirectUri)
    const loginUrl = vi.fn<() => string>(() => 'https://login.example.test')
    const fetch = vi.fn<TestFetch>(async () => Response.json(tokenResponse()))
    vi.stubGlobal('fetch', fetch)
    const lazy = manager({ clientId, clientSecret, redirectUri: redirect, loginUrl })
    expect(clientId).not.toHaveBeenCalled()
    expect(clientSecret).not.toHaveBeenCalled()
    expect(redirect).not.toHaveBeenCalled()
    expect(loginUrl).not.toHaveBeenCalled()
    expect(fetch).not.toHaveBeenCalled()

    expect(revealSecret((await authorize(lazy)).accessToken)).toBe('access-token')
    const lazyRequest = fetch.mock.calls[0]!
    expect(String(lazyRequest[0])).toBe('https://login.example.test/services/oauth2/token')
    expect(new URLSearchParams(String(lazyRequest[1]?.body)).get('client_secret')).toBe(
      'client-secret',
    )
    expect(
      revealSecret((await authorize(manager({ clientSecret: 'plain-client-secret' }))).accessToken),
    ).toBe('access-token')
    expect(new URLSearchParams(String(fetch.mock.calls[1]?.[1]?.body)).get('client_secret')).toBe(
      'plain-client-secret',
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
    const throwing = manager({
      clientId: () => {
        throw new Error(canary)
      },
    })
    const failure = await throwing
      .startAuthorization('connection', { binding: 'session' })
      .catch((error: unknown) => error)
    expect(failure).toMatchObject({ _tag: 'AuthorizationFailure', reason: 'ProviderFailure' })
    expect([JSON.stringify(failure), String(failure), inspect(failure)].join('\n')).not.toContain(
      canary,
    )
    expect(fetch).not.toHaveBeenCalled()
  })

  test('rejects a token redirect without exfiltrating the POST body', async () => {
    const redirectTarget = await startSalesforceServer({
      token: [{ _tag: 'Response', status: 200, json: tokenResponse() }],
    })
    servers.add(redirectTarget)
    const tokenEndpoint = await startSalesforceServer({
      token: [
        {
          _tag: 'Response',
          status: 307,
          headers: {
            location: new URL('/services/oauth2/token', redirectTarget.loginUrl).toString(),
          },
        },
      ],
    })
    servers.add(tokenEndpoint)

    await expect(authorize(manager({ loginUrl: tokenEndpoint.loginUrl }))).rejects.toMatchObject({
      _tag: 'AuthorizationFailure',
      reason: 'InterventionRequired',
    })
    expect(tokenEndpoint.tokenRequestCount).toBe(1)
    expect(redirectTarget.tokenRequestCount).toBe(0)
  })

  test.each([
    ['expires_in', 'not-a-duration'],
    ['expires_in', 0],
    ['expires_in', null],
    ['issued_at', 'not-a-timestamp'],
    ['issued_at', ''],
    ['issued_at', -1],
    ['issued_at', null],
  ] as const)(
    'does not authorize credentials with a present invalid %s field: %s',
    async (field, value) => {
      const fetch = vi.fn<TestFetch>(async () =>
        Response.json({ ...tokenResponse(), [field]: value }),
      )
      vi.stubGlobal('fetch', fetch)

      await expect(authorize()).rejects.toMatchObject({
        _tag: 'AuthorizationFailure',
        reason: 'ProviderFailure',
      })
      expect(fetch).toHaveBeenCalledOnce()
    },
  )

  test('returns reusable credentials when Salesforce omits optional timing fields', async () => {
    const fetch = vi.fn<TestFetch>(async () => Response.json(tokenResponse()))
    vi.stubGlobal('fetch', fetch)
    const configured = manager()
    const credentials = await authorize(configured)
    expect(revealSecret(credentials.accessToken)).toBe('access-token')
    expect(credentials.instanceUrl).toBe('https://instance.example.test')
    expect(revealSecret((await configured.credentials('connection')).accessToken)).toBe(
      'access-token',
    )
    expect(fetch).toHaveBeenCalledOnce()
  })

  test('rejects an otherwise usable token response larger than one MiB', async () => {
    const fetch = vi.fn<TestFetch>(async () =>
      Response.json({
        ...tokenResponse(),
        access_token: 'x'.repeat(1024 * 1024),
      }),
    )
    vi.stubGlobal('fetch', fetch)
    await expect(authorize()).rejects.toMatchObject({
      _tag: 'AuthorizationFailure',
      reason: 'ProviderFailure',
    })
    expect(fetch).toHaveBeenCalledOnce()
  })

  test('aborts a stalled token response and reports uncertainty instead of completing authorization', async () => {
    vi.useFakeTimers()
    const started = Promise.withResolvers<AbortSignal>()
    const fetch = vi.fn<TestFetch>(async (_url, init) => {
      if (init?.signal == null) throw new Error('Expected cancellation signal')
      const signal = init.signal
      const response = new Response(
        new ReadableStream({
          start(controller) {
            signal.addEventListener('abort', () =>
              controller.error(new DOMException('Aborted', 'AbortError')),
            )
          },
        }),
      )
      started.resolve(signal)
      return response
    })
    vi.stubGlobal('fetch', fetch)
    const result = authorize().catch((error: unknown) => error)
    const signal = await started.promise
    try {
      await vi.advanceTimersByTimeAsync(30_000)
      expect(await result).toMatchObject({
        _tag: 'AuthorizationFailure',
        reason: 'InterventionRequired',
      })
      expect(signal.aborted).toBe(true)
    } finally {
      await vi.runAllTimersAsync()
      await result
    }
  })
})
