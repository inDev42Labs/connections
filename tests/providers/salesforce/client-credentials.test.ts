import { inspect } from 'node:util'
import { Effect, Redacted } from 'effect'
import { describe, expect, test, vi } from 'vitest'
import { Connections, revealSecret } from '../../../src/index.js'
import { Salesforce } from '../../../src/providers/salesforce/index.js'
import { Memory } from '../../../src/stores/memory/index.js'
import { startSalesforceServer } from '../../fixtures/salesforce-server.js'
import { makeLifecycleDriver, makeTestClock } from '../../fixtures/lifecycle-driver.js'
import { makeInMemoryStore, replaceSavedCredentialPayload } from '../../fixtures/in-memory-store.js'

const loginUrl = 'https://example.my.salesforce.com'
const source = { clientId: 'client&id', clientSecret: 'secret+&=' }
const token = {
  access_token: 'access-1',
  instance_url: loginUrl,
  token_type: 'Bearer',
  issued_at: '1000',
}
const json = (body: unknown) => Response.json(body)
const store = () => Memory.store({ encryptionKey: 'AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE=' })
type TestFetch = (...args: Parameters<typeof globalThis.fetch>) => Promise<Response>

async function enrolled(response: Response | Error) {
  const fetch = vi.fn<TestFetch>(async () => {
    if (response instanceof Error) throw response
    return response
  })
  const manager = Connections.create({
    provider: Salesforce.clientCredentials({ loginUrl, fetch }),
    store: store(),
  })
  await manager.setClientCredentials('connection', source)
  return { manager, fetch }
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
      .fn<TestFetch>()
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
    expect(request).toMatchObject({ method: 'POST', redirect: 'error' })
    expect(new Headers(request?.headers).get('content-type')).toBe(
      'application/x-www-form-urlencoded',
    )
    expect(Object.fromEntries(new URLSearchParams(String(request?.body)))).toEqual({
      grant_type: 'client_credentials',
      client_id: source.clientId,
      client_secret: source.clientSecret,
    })
    expect(revealSecret((await manager.credentials('connection')).accessToken)).toBe('access-1')
    expect(fetch).toHaveBeenCalledOnce()
    await use.reportRejected()
    const renewed = await Effect.runPromise(manager.effect.credentials('connection'))
    expect(revealSecret(renewed.accessToken)).toBe('access-2')
    expect(fetch).toHaveBeenCalledTimes(2)
  })

  test('uses the retained source to renew at the reported expiry without a refresh token', async () => {
    const clock = makeTestClock(1_000)
    const driver = makeLifecycleDriver(clock.layer)
    const fetch = vi
      .fn<TestFetch>()
      .mockResolvedValueOnce(json({ ...token, expires_in: '60' }))
      .mockResolvedValueOnce(json({ ...token, access_token: 'renewed', issued_at: '61000' }))
    const manager = Connections.create({
      store: store(),
      provider: Salesforce.clientCredentials({ loginUrl, fetch }),
    })
    try {
      await driver.run(clock.initialize)
      await driver.run(manager.effect.setClientCredentials('connection', source))
      const first = await driver.run(manager.effect.credentials('connection'))
      expect(revealSecret(first.accessToken)).toBe('access-1')
      await driver.run(clock.advanceBy(59_999))
      expect(
        revealSecret((await driver.run(manager.effect.credentials('connection'))).accessToken),
      ).toBe('access-1')
      expect(fetch).toHaveBeenCalledOnce()
      await driver.run(clock.advanceBy(1))
      expect(
        revealSecret((await driver.run(manager.effect.credentials('connection'))).accessToken),
      ).toBe('renewed')
      expect(fetch).toHaveBeenCalledTimes(2)
      expect(
        fetch.mock.calls.map(([, request]) =>
          Object.fromEntries(new URLSearchParams(String(request?.body))),
        ),
      ).toEqual([
        {
          grant_type: 'client_credentials',
          client_id: source.clientId,
          client_secret: source.clientSecret,
        },
        {
          grant_type: 'client_credentials',
          client_id: source.clientId,
          client_secret: source.clientSecret,
        },
      ])
    } finally {
      await driver.dispose()
    }
  })

  test('never returns already expired credentials and can acquire a fresh credential on the next read', async () => {
    const clock = makeTestClock(1_000)
    const driver = makeLifecycleDriver(clock.layer)
    const fetch = vi
      .fn<TestFetch>()
      .mockResolvedValueOnce(json({ ...token, issued_at: '0', expires_in: 1 }))
      .mockResolvedValueOnce(json({ ...token, access_token: 'fresh', issued_at: undefined }))
    const manager = Connections.create({
      store: store(),
      provider: Salesforce.clientCredentials({ loginUrl, fetch }),
    })
    try {
      await driver.run(clock.initialize)
      await driver.run(
        manager.effect.setClientCredentials('id', {
          ...source,
          clientSecret: Redacted.make(source.clientSecret),
        }),
      )
      await expect(driver.run(manager.effect.credentials('id'))).rejects.toMatchObject({
        _tag: 'TemporarilyUnavailable',
        cause: { _tag: 'ProviderFailure' },
      })
      expect(revealSecret((await driver.run(manager.effect.credentials('id'))).accessToken)).toBe(
        'fresh',
      )
      expect(fetch).toHaveBeenCalledTimes(2)
    } finally {
      await driver.dispose()
    }
  })

  test('replaces the saved source deliberately and removes authorization locally', async () => {
    const fetch = vi.fn<TestFetch>(async () => json(token))
    const manager = Connections.create({
      store: store(),
      provider: Salesforce.clientCredentials({ loginUrl, fetch }),
    })
    await manager.setClientCredentials('id', source)
    await expect(manager.setClientCredentials('id', source)).rejects.toMatchObject({
      _tag: 'CredentialConfigurationFailure',
      reason: 'Conflict',
    })
    await manager.setClientCredentials(
      'id',
      { clientId: 'new-id', clientSecret: 'new-secret' },
      { replace: true },
    )
    await manager.credentials('id')
    expect(Object.fromEntries(new URLSearchParams(String(fetch.mock.calls[0]![1]?.body)))).toEqual({
      grant_type: 'client_credentials',
      client_id: 'new-id',
      client_secret: 'new-secret',
    })
    await manager.remove('id')
    await expect(manager.credentials('id')).rejects.toMatchObject({ _tag: 'AuthorizationRequired' })
    expect(fetch).toHaveBeenCalledOnce()
  })

  test.each([
    [400, 'AuthorizationRequired'],
    [401, 'AuthorizationRequired'],
    [403, 'TemporarilyUnavailable'],
    [429, 'InterventionRequired'],
    [500, 'InterventionRequired'],
  ] as const)('reports HTTP %s as %s without replaying acquisition', async (status, tag) => {
    const { manager, fetch } = await enrolled(new Response('', { status }))
    await expect(manager.credentials('connection')).rejects.toMatchObject({ _tag: tag })
    await expect(manager.credentials('connection')).rejects.toMatchObject({ _tag: tag })
    expect(fetch).toHaveBeenCalledOnce()
  })

  test('retains uncertainty on transport loss without replaying acquisition', async () => {
    const { manager, fetch } = await enrolled(new Error('lost'))
    await expect(manager.credentials('connection')).rejects.toMatchObject({
      _tag: 'InterventionRequired',
      cause: { _tag: 'ProviderOutcomeUnknown' },
    })
    await expect(manager.credentials('connection')).rejects.toMatchObject({
      _tag: 'InterventionRequired',
    })
    expect(fetch).toHaveBeenCalledOnce()
  })

  test.each([
    ['missing fields', {}],
    ['unsupported token type', { ...token, token_type: 'basic' }],
    ['insecure instance URL', { ...token, instance_url: 'http://example.com' }],
    ['empty access token', { ...token, access_token: '' }],
    ['invalid expiry', { ...token, expires_in: 0 }],
    ['invalid issue time', { ...token, issued_at: 'bad' }],
  ])('does not return credentials or replay after a response with %s', async (_name, body) => {
    const { manager, fetch } = await enrolled(json(body))
    await expect(manager.credentials('connection')).rejects.toMatchObject({
      _tag: 'InterventionRequired',
      cause: { _tag: 'ProviderOutcomeUnknown' },
    })
    await expect(manager.credentials('connection')).rejects.toMatchObject({
      _tag: 'InterventionRequired',
    })
    expect(fetch).toHaveBeenCalledOnce()
  })

  test('retains uncertainty for malformed JSON without replaying acquisition', async () => {
    const { manager, fetch } = await enrolled(new Response('{'))
    await expect(manager.credentials('connection')).rejects.toMatchObject({
      _tag: 'InterventionRequired',
    })
    await expect(manager.credentials('connection')).rejects.toMatchObject({
      _tag: 'InterventionRequired',
    })
    expect(fetch).toHaveBeenCalledOnce()
  })

  test.each([
    'https://login.salesforce.com',
    'https://test.salesforce.com',
    'http://example.com',
    `${loginUrl}/path`,
    `${loginUrl}?query=1`,
    'https://user:secret@example.com',
  ])('rejects an unsupported endpoint without dispatching: %s', async (url) => {
    const fetch = vi.fn<TestFetch>()
    const manager = Connections.create({
      store: store(),
      provider: Salesforce.clientCredentials({ loginUrl: url, fetch }),
    })
    await manager.setClientCredentials('connection', source)
    await expect(manager.credentials('connection')).rejects.toMatchObject({
      _tag: 'TemporarilyUnavailable',
      cause: { _tag: 'ProviderFailure' },
    })
    expect(fetch).not.toHaveBeenCalled()
  })

  test.each([
    { ...source, clientSecret: '' },
    { ...source, clientId: '' },
  ])(
    'rejects an empty source without enrolling or contacting Salesforce: %o',
    async (credentials) => {
      const fetch = vi.fn<TestFetch>()
      const manager = Connections.create({
        store: store(),
        provider: Salesforce.clientCredentials({ loginUrl, fetch }),
      })
      await expect(manager.setClientCredentials('connection', credentials)).rejects.toMatchObject({
        _tag: 'CredentialConfigurationFailure',
        reason: 'InvalidCredentials',
      })
      expect(await manager.inspect('connection')).toEqual({
        savedAuthorization: false,
        credentialWork: 'idle',
      })
      expect(fetch).not.toHaveBeenCalled()
    },
  )

  test.each([false, true])(
    'fails safely for incompatible saved credentials (previously acquired: %s)',
    async (acquired) => {
      const store = makeInMemoryStore()
      const fetch = vi.fn<TestFetch>(async () => json(token))
      const manager = Connections.create({
        store,
        provider: Salesforce.clientCredentials({ loginUrl, fetch }),
      })
      await manager.setClientCredentials('connection', source)
      if (acquired) await manager.credentials('connection')
      await replaceSavedCredentialPayload(
        store,
        {
          namespace: 'default',
          providerId: 'salesforce-client-credentials',
          connectionId: 'connection',
        },
        '{"diagnostic":"__stored_secret_canary__"}',
      )

      const failure = await manager.credentials('connection').catch((error: unknown) => error)
      expect(failure).toMatchObject({
        _tag: 'TemporarilyUnavailable',
        cause: { _tag: 'ProviderFailure' },
      })
      expect([String(failure), JSON.stringify(failure), inspect(failure)].join('\n')).not.toContain(
        '__stored_secret_canary__',
      )
      expect(fetch).toHaveBeenCalledTimes(acquired ? 1 : 0)
    },
  )
})
