import { Effect } from 'effect'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { Connections, revealSecret } from '../../src/index.js'
import { Amazon } from '../../src/providers/amazon/index.js'
import { Salesforce } from '../../src/providers/salesforce/index.js'
import { Memory } from '../../src/stores/memory/index.js'

const loginUrl = 'https://example.my.salesforce.com'
const encryptionKey = 'AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE='
type TestFetch = (...args: Parameters<typeof globalThis.fetch>) => Promise<Response>

function tokenResponse(accessToken = 'derived-credential') {
  return { access_token: accessToken, instance_url: loginUrl, token_type: 'Bearer' }
}

function invalidUtf8TokenResponse() {
  const encoder = new TextEncoder()
  const prefix = encoder.encode('{"access_token":"')
  const suffix = encoder.encode(`","instance_url":"${loginUrl}","token_type":"Bearer"}`)
  const bytes = new Uint8Array(prefix.length + 1 + suffix.length)
  bytes.set(prefix)
  bytes[prefix.length] = 0xff
  bytes.set(suffix, prefix.length + 1)
  return new Response(bytes)
}

async function clientCredentials(fetch: TestFetch) {
  const manager = Connections.create({
    provider: Salesforce.clientCredentials({ loginUrl, fetch }),
    store: Memory.store({ encryptionKey }),
  })
  await manager.setClientCredentials('connection', {
    clientId: 'client-id',
    clientSecret: 'secret',
  })
  return manager
}

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('credential HTTP safety through consumer operations', () => {
  test('obtains usable credentials with a form POST that forbids redirects', async () => {
    const fetch = vi.fn<TestFetch>(async () => Response.json(tokenResponse()))
    const manager = await clientCredentials(fetch)

    const credentials = await manager.credentials('connection')

    expect(revealSecret(credentials.accessToken)).toBe('derived-credential')
    expect(credentials.instanceUrl).toBe(loginUrl)
    const [url, request] = fetch.mock.calls[0]!
    expect(String(url)).toBe(`${loginUrl}/services/oauth2/token`)
    expect(request).toMatchObject({ method: 'POST', redirect: 'error' })
    expect(new Headers(request?.headers).get('content-type')).toBe(
      'application/x-www-form-urlencoded',
    )
    expect(Object.fromEntries(new URLSearchParams(String(request?.body)))).toEqual({
      grant_type: 'client_credentials',
      client_id: 'client-id',
      client_secret: 'secret',
    })
  })

  test('releases an unread failure body and retains uncertainty without retrying acquisition', async () => {
    const cancel = vi.fn<() => void>()
    const fetch = vi.fn<TestFetch>(
      async () =>
        new Response(new ReadableStream({ cancel }), {
          status: 429,
          headers: { 'retry-after': '12' },
        }),
    )
    const manager = await clientCredentials(fetch)

    await expect(manager.credentials('connection')).rejects.toMatchObject({
      _tag: 'InterventionRequired',
      cause: { _tag: 'ProviderOutcomeUnknown' },
    })
    await expect(manager.credentials('connection')).rejects.toMatchObject({
      _tag: 'InterventionRequired',
    })
    expect(cancel).toHaveBeenCalled()
    expect(fetch).toHaveBeenCalledOnce()
  })

  test('a malformed optional OAuth error body does not turn HTTP failure into authorization rejection', async () => {
    const fetch = vi
      .fn<TestFetch>()
      .mockResolvedValueOnce(
        Response.json({
          access_token: 'initial-access',
          refresh_token: 'initial-refresh',
          token_type: 'bearer',
          expires_in: 3600,
        }),
      )
      .mockResolvedValue(new Response('{', { status: 401 }))
    vi.stubGlobal('fetch', fetch)
    const manager = Connections.create({
      provider: Amazon.oauth({
        clientId: 'client-id',
        clientSecret: 'secret',
        scopes: ['profile'],
        redirectUri: 'https://app.example/callback',
      }),
      store: Memory.store({ encryptionKey }),
    })
    const start = await manager.startAuthorization('connection', { binding: 'session' })
    const callback = new URL('https://app.example/callback')
    callback.search = new URLSearchParams({
      code: 'one-use-code',
      state: new URL(start.url).searchParams.get('state')!,
    }).toString()
    await manager.completeAuthorization({
      callbackUrl: callback.toString(),
      binding: 'session',
      authorize: () => undefined,
    })
    await (await manager.credentialUse('connection')).reportRejected()

    await expect(manager.credentials('connection')).rejects.toMatchObject({
      _tag: 'TemporarilyUnavailable',
      cause: { _tag: 'ProviderFailure' },
    })
    await expect(manager.credentials('connection')).rejects.toMatchObject({
      _tag: 'TemporarilyUnavailable',
    })
    expect(fetch).toHaveBeenCalledTimes(2)
  })

  test.each([
    ['invalid JSON', () => new Response('{')],
    ['invalid UTF-8', invalidUtf8TokenResponse],
    ['oversized body', () => Response.json(tokenResponse('x'.repeat(1024 * 1024)))],
    [
      'oversized content length',
      () =>
        new Response(JSON.stringify(tokenResponse()), {
          headers: { 'content-length': '1048577' },
        }),
    ],
  ] as const)(
    'does not return credentials or replay acquisition after %s',
    async (_name, response) => {
      const fetch = vi.fn<TestFetch>(async () => response())
      const manager = await clientCredentials(fetch)

      await expect(manager.credentials('connection')).rejects.toMatchObject({
        _tag: 'InterventionRequired',
        cause: { _tag: 'ProviderOutcomeUnknown' },
      })
      await expect(manager.credentials('connection')).rejects.toMatchObject({
        _tag: 'InterventionRequired',
      })
      expect(fetch).toHaveBeenCalledOnce()
    },
  )

  test('releases the provider response stream after rejecting an oversized credential body', async () => {
    const cancel = vi.fn<() => void>()
    const response = new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(new Uint8Array(1024 * 1024 + 1))
        },
        cancel,
      }),
    )
    const manager = await clientCredentials(async () => response)

    await expect(manager.credentials('connection')).rejects.toMatchObject({
      _tag: 'InterventionRequired',
    })
    expect(cancel).toHaveBeenCalled()
    expect(response.body?.locked).toBe(false)
  })

  test('bounds a stalled credential response and aborts the provider request', async () => {
    vi.useFakeTimers()
    const started = Promise.withResolvers<AbortSignal>()
    const manager = await clientCredentials(async (_url, init) => {
      if (init?.signal == null) throw new Error('Expected request cancellation signal')
      const signal = init.signal
      const response = new Response(
        new ReadableStream({
          start(controller) {
            signal.addEventListener('abort', () => controller.error(new Error('request aborted')))
          },
        }),
      )
      started.resolve(signal)
      return response
    })
    const result = manager.credentials('connection').catch((error: unknown) => error)
    const signal = await started.promise
    try {
      await vi.advanceTimersByTimeAsync(30_000)
      expect(await result).toMatchObject({
        _tag: 'InterventionRequired',
        cause: { _tag: 'ProviderOutcomeUnknown' },
      })
      expect(signal.aborted).toBe(true)
    } finally {
      await vi.runAllTimersAsync()
      await result
    }
  })

  test('cancelling an Effect credential read aborts its active provider request', async () => {
    const started = Promise.withResolvers<void>()
    const aborted = Promise.withResolvers<void>()
    const manager = await clientCredentials(
      (_url, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            aborted.resolve()
            reject(new Error('request aborted'))
          })
          started.resolve()
        }),
    )
    const controller = new AbortController()
    const result = Effect.runPromiseExit(manager.effect.credentials('connection'), {
      signal: controller.signal,
    })
    try {
      await started.promise
      controller.abort()
      await aborted.promise
      expect((await result)._tag).toBe('Failure')
    } finally {
      controller.abort()
      await result
    }
  })
})
