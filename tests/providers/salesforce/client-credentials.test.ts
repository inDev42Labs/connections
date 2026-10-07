import { Effect, Redacted } from 'effect'
import { describe, expect, test, vi } from 'vitest'
import { Connections, revealSecret } from '../../../src/index.js'
import { Salesforce } from '../../../src/providers/salesforce/index.js'
import { Memory } from '../../../src/stores/memory/index.js'
import { startSalesforceServer } from '../../fixtures/salesforce-server.js'

const loginUrl = 'https://example.my.salesforce.com'
const source = { clientId: 'client&id', clientSecret: 'secret+&=' }
const token = {
  access_token: 'access-1',
  instance_url: loginUrl,
  token_type: 'Bearer',
  issued_at: '1000',
}
const json = (body: unknown) =>
  new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } })
const store = () => Memory.store({ encryptionKey: 'AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE=' })

async function acquire(response: Response | Error) {
  const fetch = vi.fn<NonNullable<Parameters<typeof Salesforce.clientCredentials>[0]['fetch']>>(
    async () => {
      if (response instanceof Error) throw response
      return response
    },
  )
  const provider = Salesforce.clientCredentials({ loginUrl, fetch })
  const prepared = await Effect.runPromise(provider.prepareClientCredentials(source))
  const outcome = await Effect.runPromise(provider.acquireCredentials({ ...prepared, now: 1000 }))
  return { provider, outcome, fetch }
}

describe('Salesforce client credentials', () => {
  test('acquires through the default HTTP transport against a local Salesforce substitute', async () => {
    const server = await startSalesforceServer({
      token: [{ _tag: 'Response', status: 200, json: token }],
    })
    try {
      const manager = Connections.create({
        store: store(),
        provider: Salesforce.clientCredentials({ loginUrl: server.loginUrl }),
      })
      await manager.setClientCredentials('id', source)
      const credentials = await manager.credentials('id')
      expect(revealSecret(credentials.accessToken)).toBe('access-1')
      expect(credentials.instanceUrl).toBe(loginUrl)
      expect(server.tokenRequestCount).toBe(1)
      expect(Object.fromEntries(server.tokenRequests[0]!.form)).toEqual({
        grant_type: 'client_credentials',
        client_id: source.clientId,
        client_secret: source.clientSecret,
      })
      expect(server.authorizationRequestCount).toBe(0)
    } finally {
      await server.close()
    }
  })
  test('saves lazily, acquires a form-encoded token, and reacquires after confirmed rejection', async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(json(token))
      .mockResolvedValueOnce(json({ ...token, access_token: 'access-2' }))
    const manager = Connections.create({
      store: store(),
      provider: Salesforce.clientCredentials({ loginUrl, fetch }),
    })
    await manager.setClientCredentials('connection', source)
    expect(fetch).not.toHaveBeenCalled()
    const use = await manager.credentialUse('connection')
    expect(revealSecret(use.credentials.accessToken)).toBe('access-1')
    expect(use.credentials.instanceUrl).toBe(loginUrl)
    expect(Object.keys(use.credentials).sort()).toEqual(['accessToken', 'instanceUrl'])
    const [url, request] = fetch.mock.calls[0]!
    expect(String(url)).toBe(`${loginUrl}/services/oauth2/token`)
    expect(request).toMatchObject({
      method: 'POST',
      redirect: 'error',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
    })
    expect(request?.signal).toBeInstanceOf(AbortSignal)
    expect(String(request?.body)).toBe(
      'grant_type=client_credentials&client_id=client%26id&client_secret=secret%2B%26%3D',
    )
    expect(revealSecret((await manager.credentials('connection')).accessToken)).toBe('access-1')
    expect(fetch).toHaveBeenCalledTimes(1)
    await use.reportRejected()
    const renewed = await Effect.runPromise(manager.effect.credentials('connection'))
    expect(revealSecret(renewed.accessToken)).toBe('access-2')
    expect(fetch).toHaveBeenCalledTimes(2)
  })

  test('retains source credentials and honors reported expiry without requiring a refresh token', async () => {
    const { provider, outcome } = await acquire(json({ ...token, expires_in: '60' }))
    expect(outcome._tag).toBe('Acquired')
    if (outcome._tag !== 'Acquired') throw new Error('Expected acquisition')
    expect(outcome.credentials.credentialExpiresAt).toBe(61000)
    expect(JSON.parse(Redacted.value(outcome.credentials.protectedPayload))).toEqual({
      schemaVersion: 1,
      ...source,
      accessToken: 'access-1',
      instanceUrl: loginUrl,
    })
    const projected = await Effect.runPromise(
      provider.projectCredentials(outcome.credentials.protectedPayload),
    )
    expect(Redacted.value(projected.accessToken)).toBe('access-1')
  })

  test('reacquires expired credentials through the manager', async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(json({ ...token, expires_in: 1 }))
      .mockResolvedValueOnce(json({ ...token, access_token: 'fresh', issued_at: undefined }))
    const manager = Connections.create({
      store: store(),
      provider: Salesforce.clientCredentials({ loginUrl, fetch }),
    })
    await manager.setClientCredentials('id', {
      ...source,
      clientSecret: Redacted.make(source.clientSecret),
    })
    await expect(manager.credentials('id')).rejects.toBeDefined()
    expect(revealSecret((await manager.credentials('id')).accessToken)).toBe('fresh')
  })

  test('replaces the saved source deliberately and removes authorization', async () => {
    const fetch = vi.fn<NonNullable<Parameters<typeof Salesforce.clientCredentials>[0]['fetch']>>(
      async () => json(token),
    )
    const manager = Connections.create({
      store: store(),
      provider: Salesforce.clientCredentials({ loginUrl, fetch }),
    })
    await manager.setClientCredentials('id', source)
    await expect(manager.setClientCredentials('id', source)).rejects.toBeDefined()
    await manager.setClientCredentials(
      'id',
      { clientId: 'new-id', clientSecret: 'new-secret' },
      { replace: true },
    )
    await manager.credentials('id')
    expect(String(fetch.mock.calls[0]![1]?.body)).toContain(
      'client_id=new-id&client_secret=new-secret',
    )
    await manager.remove('id')
    await expect(manager.credentials('id')).rejects.toMatchObject({ _tag: 'AuthorizationRequired' })
  })

  test.each([
    [400, 'ProviderRejected'],
    [401, 'ProviderRejected'],
    [403, 'ProviderFailure'],
    [429, 'ProviderOutcomeUnknown'],
    [500, 'ProviderOutcomeUnknown'],
  ] as const)('classifies HTTP %s as %s', async (status, tag) => {
    expect((await acquire(new Response('', { status }))).outcome).toEqual({ _tag: tag })
  })

  test('preserves uncertainty on transport loss', async () => {
    expect((await acquire(new Error('lost'))).outcome).toEqual({ _tag: 'ProviderOutcomeUnknown' })
  })

  test.each([
    {},
    { ...token, token_type: 'basic' },
    { ...token, instance_url: 'http://example.com' },
    { ...token, access_token: '' },
    { ...token, expires_in: 0 },
    { ...token, issued_at: 'bad' },
  ])('retains uncertainty for malformed token responses', async (body) => {
    expect((await acquire(json(body))).outcome).toEqual({ _tag: 'ProviderOutcomeUnknown' })
  })

  test('retains uncertainty for malformed JSON', async () => {
    expect((await acquire(new Response('{'))).outcome).toEqual({ _tag: 'ProviderOutcomeUnknown' })
  })

  test.each([
    'https://login.salesforce.com',
    'https://test.salesforce.com',
    'http://example.com',
    `${loginUrl}/path`,
    `${loginUrl}?query=1`,
    'https://user:secret@example.com',
  ])('rejects invalid endpoint %s without dispatch', async (url) => {
    const fetch = vi.fn<typeof globalThis.fetch>()
    const provider = Salesforce.clientCredentials({ loginUrl: url, fetch })
    const prepared = await Effect.runPromise(provider.prepareClientCredentials(source))
    expect(
      await Effect.runPromise(provider.acquireCredentials({ ...prepared, now: 1000 })),
    ).toEqual({ _tag: 'ProviderFailure', recovery: 'NotDispatched' })
    expect(fetch).not.toHaveBeenCalled()
  })

  test('rejects empty sources and incompatible stored credentials', async () => {
    const provider = Salesforce.clientCredentials({ loginUrl })
    await expect(
      Effect.runPromise(provider.prepareClientCredentials({ ...source, clientSecret: '' })),
    ).rejects.toBeDefined()
    await expect(
      Effect.runPromise(provider.prepareClientCredentials({ ...source, clientId: '' })),
    ).rejects.toBeDefined()
    expect(
      await Effect.runPromise(
        provider.acquireCredentials({ protectedPayload: Redacted.make('{}'), now: 1000 }),
      ),
    ).toEqual({ _tag: 'ProviderFailure' })
    await expect(
      Effect.runPromise(provider.projectCredentials(Redacted.make('{}'))),
    ).rejects.toBeDefined()
  })
})
