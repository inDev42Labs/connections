import { Effect, Redacted } from 'effect'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { Salesforce } from '../../../src/providers/salesforce/index.js'
import {
  startSalesforceServer,
  type SalesforceTestServer,
} from '../../fixtures/salesforce-server.js'

const servers = new Set<SalesforceTestServer>()

type TestFetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>

function provider(loginUrl: string) {
  return Salesforce.oauth({
    clientId: 'client-id',
    clientSecret: Effect.succeed(Redacted.make('client-secret')),
    redirectUri: 'https://app.example.test/oauth/callback',
    scopes: ['api', 'refresh_token'],
    loginUrl,
  })
}

function exchange(loginUrl: string) {
  return provider(loginUrl).exchangeAuthorizationCode({
    code: Redacted.make('authorization-code'),
    codeVerifier: Redacted.make('pkce-verifier'),
    now: 1_000,
  })
}

afterEach(async () => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  await Promise.all([...servers].map((server) => server.close()))
  servers.clear()
})

describe('Salesforce token transport', () => {
  test('supports plain and lazy browser OAuth configuration', async () => {
    const clientId = vi.fn<() => string>(() => 'client-id')
    const clientSecret = vi.fn<() => string>(() => 'client-secret')
    const redirectUri = vi.fn<() => string>(() => 'https://app.example.test/oauth/callback')
    const loginUrl = vi.fn<() => string>(() => 'https://login.example.test')
    const fetchMock = vi.fn<TestFetch>(() =>
      Promise.resolve(
        Response.json({
          access_token: 'access-token',
          refresh_token: 'refresh-token',
          instance_url: 'https://instance.example.test',
          token_type: 'Bearer',
        }),
      ),
    )
    vi.stubGlobal('fetch', fetchMock)

    const lazyProvider = Salesforce.oauth({
      clientId,
      clientSecret,
      redirectUri,
      loginUrl,
      scopes: ['api', 'refresh_token'],
    })
    expect(clientId).not.toHaveBeenCalled()
    expect(clientSecret).not.toHaveBeenCalled()
    expect(redirectUri).not.toHaveBeenCalled()
    expect(loginUrl).not.toHaveBeenCalled()
    expect(fetchMock).not.toHaveBeenCalled()

    await Effect.runPromise(
      lazyProvider.exchangeAuthorizationCode({
        code: Redacted.make('authorization-code'),
        codeVerifier: Redacted.make('pkce-verifier'),
        now: 1_000,
      }),
    )

    expect(clientId).toHaveBeenCalledOnce()
    expect(clientSecret).toHaveBeenCalledOnce()
    expect(redirectUri).toHaveBeenCalledOnce()
    expect(loginUrl).toHaveBeenCalledOnce()
    const requestBody = fetchMock.mock.calls[0]?.[1]?.body
    expect(requestBody).toBeInstanceOf(URLSearchParams)
    expect((requestBody as URLSearchParams).get('client_secret')).toBe('client-secret')

    const plainProvider = Salesforce.oauth({
      clientId: 'client-id',
      clientSecret: 'plain-client-secret',
      redirectUri: 'https://app.example.test/oauth/callback',
      scopes: ['api', 'refresh_token'],
    })
    await Effect.runPromise(
      plainProvider.exchangeAuthorizationCode({
        code: Redacted.make('authorization-code'),
        codeVerifier: Redacted.make('pkce-verifier'),
        now: 1_000,
      }),
    )
    const plainBody = fetchMock.mock.calls[1]?.[1]?.body
    expect(plainBody).toBeInstanceOf(URLSearchParams)
    expect((plainBody as URLSearchParams).get('client_secret')).toBe('plain-client-secret')
  })

  test('maps missing or throwing configuration getters to safe invalid configuration failures', async () => {
    const fetchMock = vi.fn<TestFetch>()
    vi.stubGlobal('fetch', fetchMock)
    const input = {
      code: Redacted.make('authorization-code'),
      codeVerifier: Redacted.make('pkce-verifier'),
      now: 1_000,
    }
    const missingSecret = Salesforce.oauth({
      clientId: 'client-id',
      clientSecret: () => undefined as unknown as string,
      redirectUri: 'https://app.example.test/oauth/callback',
      scopes: ['api', 'refresh_token'],
    })
    const secretFailure = await Effect.runPromise(
      Effect.flip(missingSecret.exchangeAuthorizationCode(input)),
    )
    expect(secretFailure).toMatchObject({ reason: 'InvalidConfiguration' })

    const secretInThrownError = 'do-not-leak-this-secret'
    const throwingClientId = Salesforce.oauth({
      clientId: () => {
        throw new Error(secretInThrownError)
      },
      clientSecret: 'client-secret',
      redirectUri: 'https://app.example.test/oauth/callback',
      scopes: ['api', 'refresh_token'],
    })
    const clientIdFailure = await Effect.runPromise(
      Effect.flip(
        throwingClientId.authorizationUrl({
          state: 'state-value',
          codeChallenge: 'pkce-challenge',
        }),
      ),
    )
    expect(clientIdFailure).toMatchObject({ reason: 'InvalidConfiguration' })
    expect(JSON.stringify(clientIdFailure)).not.toContain(secretInThrownError)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  test('rejects a token redirect without exfiltrating the POST body', async () => {
    const redirectTarget = await startSalesforceServer({
      token: [
        {
          _tag: 'Response',
          status: 200,
          json: {
            access_token: 'redirected-access-token',
            refresh_token: 'redirected-refresh-token',
            instance_url: 'https://instance.example.test',
            token_type: 'Bearer',
          },
        },
      ],
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

    const failure = await Effect.runPromise(Effect.flip(exchange(tokenEndpoint.loginUrl)))

    expect(failure).toMatchObject({ reason: 'TransportFailure' })
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
  ] as const)('rejects a present invalid %s field as malformed', async (field, value) => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve(
          Response.json({
            access_token: 'access-token',
            refresh_token: 'refresh-token',
            instance_url: 'https://instance.example.test',
            token_type: 'Bearer',
            [field]: value,
          }),
        ),
      ),
    )

    const failure = await Effect.runPromise(Effect.flip(exchange('https://login.example.test')))

    expect(failure).toMatchObject({ reason: 'MalformedResponse' })
  })

  test('accepts a token response that omits optional timing fields', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve(
          Response.json({
            access_token: 'access-token',
            refresh_token: 'refresh-token',
            instance_url: 'https://instance.example.test',
            token_type: 'Bearer',
          }),
        ),
      ),
    )

    await expect(Effect.runPromise(exchange('https://login.example.test'))).resolves.toMatchObject({
      credentialExpiresAt: null,
    })
  })

  test('rejects a token response body larger than one MiB before parsing it', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(new Response(new Uint8Array(1024 * 1024 + 1), { status: 200 }))),
    )

    const failure = await Effect.runPromise(Effect.flip(exchange('https://login.example.test')))

    expect(failure).toMatchObject({ reason: 'MalformedResponse' })
  })

  test('keeps the 30-second abort boundary active while reading the response body', async () => {
    vi.useFakeTimers()
    let responseController: ReadableStreamDefaultController<Uint8Array> | undefined
    let requestSignal: AbortSignal | null | undefined
    let requestStarted: () => void = () => undefined
    const started = new Promise<void>((resolve) => {
      requestStarted = resolve
    })
    vi.stubGlobal(
      'fetch',
      vi.fn((_input: Parameters<typeof fetch>[0], init?: RequestInit) => {
        requestSignal = init?.signal
        const body = new ReadableStream<Uint8Array>({
          start(controller) {
            responseController = controller
            requestSignal?.addEventListener(
              'abort',
              () => controller.error(new DOMException('Aborted', 'AbortError')),
              { once: true },
            )
          },
        })
        requestStarted()
        return Promise.resolve(
          new Response(body, { status: 200, headers: { 'content-type': 'application/json' } }),
        )
      }),
    )

    const result = Effect.runPromise(Effect.flip(exchange('https://login.example.test')))
    await started

    try {
      await vi.advanceTimersByTimeAsync(30_000)
      expect(requestSignal?.aborted).toBe(true)
      await expect(result).resolves.toMatchObject({ reason: 'TransportFailure' })
    } finally {
      try {
        responseController?.error(new Error('test cleanup'))
      } catch {
        // The timeout already errored the stream.
      }
      await result.catch(() => undefined)
    }
  })
})
