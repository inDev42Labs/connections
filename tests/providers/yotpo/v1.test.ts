import { inspect } from 'node:util'
import { Redacted } from 'effect'
import { describe, expect, test } from 'vitest'
import { Connections, revealSecret } from '../../../src/index.js'
import { Yotpo } from '../../../src/providers/yotpo/index.js'
import { Memory } from '../../../src/stores/memory/index.js'
import { makeYotpoTokenSubstitute, yotpoTokenResponse } from '../../fixtures/yotpo-server.js'

function fixture(responses: readonly (Response | Error)[]) {
  const server = makeYotpoTokenSubstitute(responses)
  const manager = Connections.create({
    provider: Yotpo.clientCredentials({ version: 'v1', fetch: server.fetch as typeof fetch }),
    store: Memory.store({ encryptionKey: 'KioqKioqKioqKioqKioqKioqKioqKioqKioqKioqKio=' }),
  })
  return { server, manager }
}
const source = { storeId: 'store-id', apiSecret: 'api-secret' }

describe('Yotpo UGC API V1', () => {
  test('saves sources locally and obtains reusable credentials with the documented JSON request', async () => {
    const { manager, server } = fixture([yotpoTokenResponse()])
    await manager.setClientCredentials('connection', source)
    expect(server.requests()).toEqual([])

    const credentials = await manager.credentials('connection')
    expect(credentials.storeId).toBe('store-id')
    expect(revealSecret(credentials.accessToken)).toBe('yotpo-access-token')
    expect(Object.keys(credentials).sort()).toEqual(['accessToken', 'storeId'])
    expect(revealSecret((await manager.credentials('connection')).accessToken)).toBe(
      'yotpo-access-token',
    )
    expect(server.requests()).toHaveLength(1)
    const request = server.requests()[0]!
    expect(request.url).toBe('https://api.yotpo.com/oauth/token')
    expect(request.init).toMatchObject({ method: 'POST', redirect: 'error' })
    expect(new Headers(request.init?.headers).get('content-type')).toBe('application/json')
    expect(new Headers(request.init?.headers).get('accept')).toBe('application/json')
    expect(JSON.parse(String(request.init?.body))).toEqual({
      client_id: 'store-id',
      client_secret: 'api-secret',
      grant_type: 'client_credentials',
    })
  })

  test.each([
    { storeId: '', apiSecret: Redacted.make('api-secret') },
    { storeId: 'store-id', apiSecret: Redacted.make('') },
  ])('rejects an invalid source without enrolling or dispatching: %o', async (credentials) => {
    const { manager, server } = fixture([])
    await expect(manager.setClientCredentials('connection', credentials)).rejects.toMatchObject({
      _tag: 'CredentialConfigurationFailure',
      reason: 'InvalidCredentials',
    })
    expect(await manager.inspect('connection')).toEqual({
      savedAuthorization: false,
      credentialWork: 'idle',
    })
    expect(server.requests()).toEqual([])
  })

  test.each([400, 401, 404])(
    'requires authorization after credential rejection HTTP %i without replay',
    async (status) => {
      const { manager, server } = fixture([new Response('{"error":"invalid_client"}', { status })])
      await manager.setClientCredentials('connection', source)

      await expect(manager.credentials('connection')).rejects.toMatchObject({
        _tag: 'AuthorizationRequired',
      })
      await expect(manager.credentials('connection')).rejects.toMatchObject({
        _tag: 'AuthorizationRequired',
      })
      expect(server.requests()).toHaveLength(1)
    },
  )

  test.each([
    [403, 'TemporarilyUnavailable', 'ProviderFailure'],
    [429, 'InterventionRequired', 'ProviderOutcomeUnknown'],
    [500, 'InterventionRequired', 'ProviderOutcomeUnknown'],
  ] as const)(
    'reports HTTP %i as %s without inventing a credential rejection or retry',
    async (status, expected, cause) => {
      const { manager, server } = fixture([new Response('error', { status })])
      await manager.setClientCredentials('connection', source)

      await expect(manager.credentials('connection')).rejects.toMatchObject({
        _tag: expected,
        cause: { _tag: cause },
      })
      await expect(manager.credentials('connection')).rejects.toMatchObject({ _tag: expected })
      expect(server.requests()).toHaveLength(1)
    },
  )

  test.each([
    ['malformed JSON', () => new Response('{')],
    ['oversized JSON', () => yotpoTokenResponse({ access_token: 'x'.repeat(1024 * 1024) })],
    [
      'invalid UTF-8',
      () => {
        const prefix = new TextEncoder().encode('{"access_token":"')
        const suffix = new TextEncoder().encode('","token_type":"Bearer"}')
        const bytes = new Uint8Array(prefix.length + 1 + suffix.length)
        bytes.set(prefix)
        bytes[prefix.length] = 0xff
        bytes.set(suffix, prefix.length + 1)
        return new Response(bytes)
      },
    ],
  ] as const)(
    'requires intervention without returning credentials or replaying after %s',
    async (_name, response) => {
      const { manager, server } = fixture([response()])
      await manager.setClientCredentials('connection', source)

      await expect(manager.credentials('connection')).rejects.toMatchObject({
        _tag: 'InterventionRequired',
        cause: { _tag: 'ProviderOutcomeUnknown' },
      })
      await expect(manager.credentials('connection')).rejects.toMatchObject({
        _tag: 'InterventionRequired',
      })
      expect(server.requests()).toHaveLength(1)
    },
  )

  test('retains transport uncertainty instead of replaying acquisition', async () => {
    const { manager, server } = fixture([new Error('transport lost')])
    await manager.setClientCredentials('connection', source)

    await expect(manager.credentials('connection')).rejects.toMatchObject({
      _tag: 'InterventionRequired',
      cause: { _tag: 'ProviderOutcomeUnknown' },
    })
    await expect(manager.credentials('connection')).rejects.toMatchObject({
      _tag: 'InterventionRequired',
    })
    expect(server.requests()).toHaveLength(1)
  })

  test('keeps source secrets out of usable credentials and public failures', async () => {
    const canary = 'yotpo-source-secret-canary'
    const { manager } = fixture([
      yotpoTokenResponse({ access_token: 'access-token-canary' }),
      new Error(`transport failed: ${canary}`),
    ])
    await manager.setClientCredentials('connection', { storeId: 'store-id', apiSecret: canary })
    const use = await manager.credentialUse('connection')
    expect(JSON.stringify(use.credentials)).not.toContain(canary)
    expect(Object.values(use.credentials)).not.toContain(canary)
    expect(revealSecret(use.credentials.accessToken)).toBe('access-token-canary')

    await use.reportRejected()
    const failure = await manager.credentials('connection').catch((error: unknown) => error)
    expect(failure).toMatchObject({ _tag: 'InterventionRequired' })
    expect([String(failure), JSON.stringify(failure), inspect(failure)].join('\n')).not.toContain(
      canary,
    )
  })
})
