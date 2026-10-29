import { Effect } from 'effect'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { MalformedJsonResponse, postCredentialRequest } from '../../src/providers/internal/http.js'

const url = new URL('https://provider.example/token')
const headers = { 'content-type': 'application/x-www-form-urlencoded' }
const body = new URLSearchParams({ grant_type: 'refresh_token' })

afterEach(() => vi.useRealTimers())

describe('credential-request lifetime', () => {
  test('posts without following redirects and returns consumed JSON', async () => {
    const response = Response.json({ access_token: 'derived-credential' })
    const fetch = vi.fn<(...args: Parameters<typeof globalThis.fetch>) => Promise<Response>>(
      async () => response,
    )
    const result = await Effect.runPromise(postCredentialRequest({ url, headers, body, fetch }))
    expect(result).toEqual({ _tag: 'Success', body: { access_token: 'derived-credential' } })
    expect(response.bodyUsed).toBe(true)
    expect(fetch).toHaveBeenCalledWith(
      url,
      expect.objectContaining({ method: 'POST', headers, body, redirect: 'error' }),
    )
  })

  test('discards unneeded error bodies and preserves status and retry evidence', async () => {
    const cancel = vi.fn<() => void>()
    const response = new Response(new ReadableStream({ cancel }), {
      status: 429,
      headers: { 'retry-after': '12' },
    })
    const result = await Effect.runPromise(
      postCredentialRequest({ url, headers, body, fetch: async () => response }),
    )
    expect(result).toEqual({ _tag: 'HttpFailure', status: 429, retryAfter: '12', body: null })
    expect(cancel).toHaveBeenCalledOnce()
  })

  test('reads only the error statuses requested by the provider adapter', async () => {
    const result = await Effect.runPromise(
      postCredentialRequest({
        url,
        headers,
        body,
        errorBodyStatuses: [400, 401],
        fetch: async () => Response.json({ error: 'invalid_grant' }, { status: 400 }),
      }),
    )
    expect(result).toEqual({
      _tag: 'HttpFailure',
      status: 400,
      retryAfter: null,
      body: { error: 'invalid_grant' },
    })
  })

  test('retains HTTP failure evidence when its optional error body is malformed', async () => {
    const result = await Effect.runPromise(
      postCredentialRequest({
        url,
        headers,
        body,
        errorBodyStatuses: [401],
        fetch: async () => new Response('{', { status: 401 }),
      }),
    )
    expect(result).toEqual({ _tag: 'HttpFailure', status: 401, retryAfter: null, body: null })
  })

  test.each([
    ['invalid JSON', () => new Response('{')],
    ['invalid UTF-8', () => new Response(new Uint8Array([0xff]))],
    ['oversized body', () => new Response(new Uint8Array(1024 * 1024 + 1))],
    [
      'oversized content length',
      () => new Response('{}', { headers: { 'content-length': '1048577' } }),
    ],
  ] as const)('rejects a successful response with %s', async (_name, response) => {
    const failure = await Effect.runPromise(
      Effect.flip(postCredentialRequest({ url, headers, body, fetch: async () => response() })),
    )
    expect(failure).toBeInstanceOf(MalformedJsonResponse)
  })

  test('cancels an abandoned body after reading fails', async () => {
    const cancel = vi.fn<() => void>()
    const response = new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(new Uint8Array(1024 * 1024 + 1))
        },
        cancel,
      }),
    )
    await Effect.runPromise(
      Effect.flip(postCredentialRequest({ url, headers, body, fetch: async () => response })),
    )
    expect(cancel).toHaveBeenCalledOnce()
    expect(response.body?.locked).toBe(false)
  })

  test('bounds a stalled body read with the request timeout', async () => {
    vi.useFakeTimers()
    const started = Promise.withResolvers<void>()
    const request = Effect.runPromise(
      Effect.flip(
        postCredentialRequest({
          url,
          headers,
          body,
          fetch: async (_url, init) => {
            const stream = new ReadableStream({
              start(controller) {
                init?.signal?.addEventListener('abort', () =>
                  controller.error(new Error('request aborted')),
                )
              },
            })
            started.resolve()
            return new Response(stream)
          },
        }),
      ),
    )
    await started.promise
    await vi.advanceTimersByTimeAsync(30_000)
    expect(await request).toBeInstanceOf(Error)
    expect(vi.getTimerCount()).toBe(0)
  })

  test('propagates caller cancellation to the active fetch', async () => {
    const started = Promise.withResolvers<void>()
    const aborted = Promise.withResolvers<void>()
    const controller = new AbortController()
    const request = Effect.runPromiseExit(
      postCredentialRequest({
        url,
        headers,
        body,
        fetch: (_url, init) =>
          new Promise((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () => {
              aborted.resolve()
              reject(new Error('request aborted'))
            })
            started.resolve()
          }),
      }),
      { signal: controller.signal },
    )
    await started.promise
    controller.abort()
    await aborted.promise
    expect((await request)._tag).toBe('Failure')
  })
})
