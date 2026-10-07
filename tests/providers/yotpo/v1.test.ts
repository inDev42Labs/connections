import { Effect, Redacted } from 'effect'
import { describe, expect, test } from 'vitest'
import { Yotpo } from '../../../src/providers/yotpo/index.js'
import { makeYotpoTokenSubstitute, yotpoTokenResponse } from '../../fixtures/yotpo-server.js'

function source(storeId = 'store-id', apiSecret = 'api-secret') {
  return { storeId, apiSecret: Redacted.make(apiSecret) }
}

async function prepared(provider: ReturnType<typeof Yotpo.clientCredentials>) {
  return Effect.runPromise(provider.prepareClientCredentials(source()))
}

describe('Yotpo UGC API V1', () => {
  test('validates source credentials locally and acquires with the documented JSON request', async () => {
    const server = makeYotpoTokenSubstitute([yotpoTokenResponse()])
    const provider = Yotpo.clientCredentials({ version: 'v1', fetch: server.fetch as typeof fetch })
    const initial = await prepared(provider)

    expect(server.requests()).toEqual([])
    const outcome = await Effect.runPromise(
      provider.acquireCredentials({ protectedPayload: initial.protectedPayload, now: 1_000 }),
    )

    expect(server.requests()).toHaveLength(1)
    expect(server.requests()[0]).toMatchObject({
      url: 'https://api.yotpo.com/oauth/token',
      init: {
        method: 'POST',
        headers: { accept: 'application/json', 'content-type': 'application/json' },
        body: JSON.stringify({
          client_id: 'store-id',
          client_secret: 'api-secret',
          grant_type: 'client_credentials',
        }),
        redirect: 'error',
      },
    })
    expect(outcome._tag).toBe('Acquired')
    if (outcome._tag !== 'Acquired') throw new Error('Expected acquired credentials')
    expect(outcome.credentials.credentialExpiresAt).toBeNull()
    const credentials = await Effect.runPromise(
      provider.projectCredentials(outcome.credentials.protectedPayload),
    )
    expect(credentials.storeId).toBe('store-id')
    expect(Redacted.value(credentials.accessToken)).toBe('yotpo-access-token')
    expect(Object.keys(credentials).sort()).toEqual(['accessToken', 'storeId'])
  })

  test.each([
    [{ storeId: '', apiSecret: Redacted.make('api-secret') }],
    [{ storeId: 'store-id', apiSecret: Redacted.make('') }],
  ])('rejects invalid source credentials without dispatching', async (credentials) => {
    const server = makeYotpoTokenSubstitute([])
    const provider = Yotpo.clientCredentials({ version: 'v1', fetch: server.fetch as typeof fetch })
    const failure = await Effect.runPromise(
      Effect.flip(provider.prepareClientCredentials(credentials)),
    )

    expect(failure).toMatchObject({ reason: 'InvalidConfiguration' })
    expect(server.requests()).toEqual([])
  })

  test.each([400, 401, 404])(
    'maps documented credential rejection status %i separately',
    async (status) => {
      const server = makeYotpoTokenSubstitute([
        new Response('{"error":"invalid_client"}', { status }),
      ])
      const provider = Yotpo.clientCredentials({
        version: 'v1',
        fetch: server.fetch as typeof fetch,
      })
      const outcome = await Effect.runPromise(
        provider.acquireCredentials({
          protectedPayload: (await prepared(provider)).protectedPayload,
          now: 0,
        }),
      )
      expect(outcome).toEqual({ _tag: 'ProviderRejected' })
    },
  )

  test.each([
    [403, 'ProviderFailure'],
    [429, 'ProviderOutcomeUnknown'],
    [500, 'ProviderOutcomeUnknown'],
  ])('maps non-credential status %i to %s', async (status, expected) => {
    const server = makeYotpoTokenSubstitute([new Response('error', { status })])
    const provider = Yotpo.clientCredentials({ version: 'v1', fetch: server.fetch as typeof fetch })
    const outcome = await Effect.runPromise(
      provider.acquireCredentials({
        protectedPayload: (await prepared(provider)).protectedPayload,
        now: 0,
      }),
    )
    expect(outcome).toEqual({ _tag: expected })
  })

  test.each([
    ['malformed JSON', new Response('{', { status: 200 })],
    ['oversized JSON', new Response(new Uint8Array(1024 * 1024 + 1), { status: 200 })],
    ['invalid UTF-8', new Response(new Uint8Array([0xff]), { status: 200 })],
  ])('fails closed for %s responses', async (_name, response) => {
    const server = makeYotpoTokenSubstitute([response])
    const provider = Yotpo.clientCredentials({ version: 'v1', fetch: server.fetch as typeof fetch })
    const outcome = await Effect.runPromise(
      provider.acquireCredentials({
        protectedPayload: (await prepared(provider)).protectedPayload,
        now: 0,
      }),
    )
    expect(outcome).toEqual({ _tag: 'ProviderFailure' })
  })

  test('preserves timeout and transport uncertainty rather than replaying', async () => {
    const server = makeYotpoTokenSubstitute([new Error('transport lost')])
    const provider = Yotpo.clientCredentials({ version: 'v1', fetch: server.fetch as typeof fetch })
    const outcome = await Effect.runPromise(
      provider.acquireCredentials({
        protectedPayload: (await prepared(provider)).protectedPayload,
        now: 0,
      }),
    )
    expect(outcome).toEqual({ _tag: 'ProviderOutcomeUnknown' })
    expect(server.requests()).toHaveLength(1)
  })

  test('does not expose source-secret canaries through projected credentials or failures', async () => {
    const canary = 'yotpo-source-secret-canary'
    const server = makeYotpoTokenSubstitute([
      yotpoTokenResponse({ access_token: 'access-token-canary' }),
    ])
    const provider = Yotpo.clientCredentials({ version: 'v1', fetch: server.fetch as typeof fetch })
    const initial = await Effect.runPromise(
      provider.prepareClientCredentials(source('store-id', canary)),
    )
    const outcome = await Effect.runPromise(
      provider.acquireCredentials({ protectedPayload: initial.protectedPayload, now: 0 }),
    )
    if (outcome._tag !== 'Acquired') throw new Error('Expected acquired credentials')
    const credentials = await Effect.runPromise(
      provider.projectCredentials(outcome.credentials.protectedPayload),
    )

    expect(JSON.stringify(credentials)).not.toContain(canary)
    expect(Object.values(credentials)).not.toContain(canary)
    expect(Redacted.value(credentials.accessToken)).toBe('access-token-canary')
  })
})
