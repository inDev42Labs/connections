import { Buffer } from 'node:buffer'
import { DatabaseSync } from 'node:sqlite'
import { Effect } from 'effect'
import { afterEach, describe, expect, test } from 'vitest'
import {
  AuthorizationRequired,
  Connections,
  InterventionRequired,
  TemporarilyUnavailable,
  revealSecret,
} from '../../src/index.js'
import { SQLite } from '../../src/stores/sqlite/index.js'
import { Salesforce } from '../../src/providers/salesforce/index.js'
import { ApiKey } from '../../src/providers/api-key/index.js'
import { Yotpo } from '../../src/providers/yotpo/index.js'
import { makeYotpoTokenSubstitute, yotpoTokenResponse } from '../fixtures/yotpo-server.js'
import {
  startSalesforceServer,
  type SalesforceTestServer,
  type ScriptedTokenOutcome,
} from '../fixtures/salesforce-server.js'

const encryptionKey = Buffer.from(new Uint8Array(32).fill(42)).toString('base64')
const wrongEncryptionKey = Buffer.from(new Uint8Array(32).fill(43)).toString('base64')
const redirectUri = 'https://app.example.test/oauth/salesforce/callback'
const servers = new Set<SalesforceTestServer>()
const databases = new Set<DatabaseSync>()

function tokenResponse(
  accessToken: string,
  issuedAt = Date.now(),
  expiresIn = 3_600,
): ScriptedTokenOutcome {
  return {
    _tag: 'Response',
    status: 200,
    json: {
      access_token: accessToken,
      refresh_token: `${accessToken}-refresh`,
      instance_url: 'https://instance.example.test',
      token_type: 'Bearer',
      issued_at: String(issuedAt),
      expires_in: expiresIn,
    },
  }
}

async function makeFixture(token: ReadonlyArray<ScriptedTokenOutcome>, enroll = true) {
  const server = await startSalesforceServer({
    authorization: [{ _tag: 'Grant', code: 'authorization-code' }],
    token,
  })
  servers.add(server)
  const database = new DatabaseSync(':memory:')
  databases.add(database)
  const store = SQLite.store({ database, encryptionKey })
  const provider = Salesforce.oauth({
    clientId: 'client-id',
    clientSecret: 'client-secret',
    redirectUri,
    scopes: ['api', 'refresh_token'],
    loginUrl: server.loginUrl,
  })
  const manager = Connections.create({ provider, store })
  if (enroll) {
    const start = await manager.startAuthorization('conn_acme', { binding: 'trusted-session' })
    const authorization = await fetch(start.url, { redirect: 'manual' })
    const callbackUrl = authorization.headers.get('location')
    if (callbackUrl === null) throw new Error('Expected an authorization callback')
    await manager.completeAuthorization({
      callbackUrl,
      binding: 'trusted-session',
      authorize: () => undefined,
    })
  }
  return { database, provider, server, store }
}

afterEach(async () => {
  await Promise.all([...servers].map((server) => server.close()))
  servers.clear()
  for (const database of databases) {
    if (database.isOpen) database.close()
  }
  databases.clear()
})

describe('Promise-first credential reads', () => {
  test('enrolls and deliberately replaces an API key without an Effect import in application code', async () => {
    const database = new DatabaseSync(':memory:')
    databases.add(database)
    const manager = Connections.create({
      store: SQLite.store({ database, encryptionKey }),
      provider: ApiKey.opaque({ id: 'retell' }),
    })

    await manager.setApiKey('conn_retell', 'first-key')
    expect(revealSecret((await manager.credentials('conn_retell')).apiKey)).toBe('first-key')
    await expect(manager.setApiKey('conn_retell', 'unintended-key')).rejects.toMatchObject({
      reason: 'Conflict',
    })
    await manager.setApiKey('conn_retell', 'replacement-key', { replace: true })
    expect(revealSecret((await manager.credentials('conn_retell')).apiKey)).toBe('replacement-key')
    expect(await manager.inspect('conn_retell')).toEqual({
      savedAuthorization: true,
      credentialWork: 'idle',
    })
    await manager.remove('conn_retell')
    await expect(
      manager.setApiKey('conn_retell', 'missing-key', { replace: true }),
    ).rejects.toMatchObject({
      reason: 'Conflict',
    })
    await expect(manager.credentials('conn_retell')).rejects.toBeInstanceOf(AuthorizationRequired)
  })

  test('saves ordinary Yotpo source strings and acquires a derived credential on read', async () => {
    const database = new DatabaseSync(':memory:')
    databases.add(database)
    const server = makeYotpoTokenSubstitute([
      yotpoTokenResponse({ access_token: 'first-token' }),
      yotpoTokenResponse({ access_token: 'replacement-token' }),
    ])
    const manager = Connections.create({
      store: SQLite.store({ database, encryptionKey }),
      provider: Yotpo.clientCredentials({ version: 'v1', fetch: server.fetch as typeof fetch }),
    })

    await manager.setClientCredentials('conn_yotpo', {
      storeId: 'store-id',
      apiSecret: 'first-secret',
    })
    expect(server.requests()).toHaveLength(0)
    expect(revealSecret((await manager.credentials('conn_yotpo')).accessToken)).toBe('first-token')
    await expect(
      manager.setClientCredentials('conn_yotpo', { storeId: 'store-id', apiSecret: 'ignored' }),
    ).rejects.toMatchObject({ reason: 'Conflict' })
    await manager.setClientCredentials(
      'conn_yotpo',
      { storeId: 'store-id', apiSecret: 'replacement-secret' },
      { replace: true },
    )
    expect(revealSecret((await manager.credentials('conn_yotpo')).accessToken)).toBe(
      'replacement-token',
    )
    expect(server.requests()).toHaveLength(2)
    expect(JSON.stringify(await manager.inspect('conn_yotpo'))).not.toContain('secret')
  })

  test('starts browser OAuth and checks application authorization before exchanging a code', async () => {
    const fixture = await makeFixture([tokenResponse('authorized-token')], false)
    const manager = Connections.create({ store: fixture.store, provider: fixture.provider })
    const { url, expiresAt } = await manager.startAuthorization('conn_acme', {
      binding: 'trusted-session',
    })
    expect(expiresAt).toBeGreaterThan(Date.now())
    const callback = (await fetch(url, { redirect: 'manual' })).headers.get('location')
    if (callback === null) throw new Error('Expected a Salesforce callback')
    const denied = new Error('Not permitted to connect this account')
    await expect(
      manager.completeAuthorization({
        callbackUrl: callback,
        binding: 'trusted-session',
        authorize: () => Promise.reject(denied),
      }),
    ).rejects.toBe(denied)
    expect(fixture.server.tokenRequestCount).toBe(0)

    const result = await manager.completeAuthorization({
      callbackUrl: callback,
      binding: 'trusted-session',
      authorize: async (target) => {
        expect(target).toEqual({ connectionId: 'conn_acme', intent: 'enroll' })
      },
    })
    expect(result).toEqual({ connectionId: 'conn_acme' })
    expect(revealSecret((await manager.credentials('conn_acme')).accessToken)).toBe(
      'authorized-token',
    )
    expect(fixture.server.tokenRequestCount).toBe(1)
    await expect(
      manager.startAuthorization('conn_acme', { binding: 'trusted-session' }),
    ).rejects.toMatchObject({ reason: 'Conflict' })
    await expect(
      manager.startAuthorization('conn_acme', { binding: 'trusted-session', replace: true }),
    ).resolves.toHaveProperty('url')
  })

  test('reads and refreshes legacy SQLite credentials through Promise and Effect surfaces', async () => {
    const fixture = await makeFixture([
      tokenResponse('expired-access-token', 0, 1),
      tokenResponse('refreshed-access-token'),
      tokenResponse('second-refreshed-access-token'),
    ])
    const manager = Connections.create({ store: fixture.store, provider: fixture.provider })

    const credentials = await manager.credentials('conn_acme')
    expect(revealSecret(credentials.accessToken)).toBe('refreshed-access-token')
    expect(credentials.instanceUrl).toBe('https://instance.example.test')
    expect(Object.keys(credentials).sort()).toEqual(['accessToken', 'instanceUrl'])
    expect(fixture.server.tokenRequestCount).toBe(2)

    const effectCredentials = await Effect.runPromise(manager.effect.credentials('conn_acme'))
    expect(effectCredentials).toEqual(credentials)
    expect(fixture.server.tokenRequestCount).toBe(2)

    const use = await manager.credentialUse('conn_acme')
    expect(use.credentials).toEqual(credentials)
    await use.reportRejected()
    const next = await manager.credentials('conn_acme')
    expect(revealSecret(next.accessToken)).toBe('second-refreshed-access-token')
    await use.reportRejected()
    expect(revealSecret((await manager.credentials('conn_acme')).accessToken)).toBe(
      'second-refreshed-access-token',
    )
    expect(fixture.server.tokenRequestCount).toBe(3)
  })

  test('maps absent authorization to AuthorizationRequired', async () => {
    const fixture = await makeFixture([], false)
    const manager = Connections.create({ store: fixture.store, provider: fixture.provider })

    await expect(manager.credentials('missing')).rejects.toBeInstanceOf(AuthorizationRequired)
    await expect(Effect.runPromise(manager.effect.credentials('missing'))).rejects.toBeInstanceOf(
      AuthorizationRequired,
    )
  })

  test('maps a competing refresh timeout to temporary unavailability without starting another refresh', async () => {
    const fixture = await makeFixture([
      tokenResponse('expired-access-token', 0, 1),
      {
        _tag: 'Response',
        status: 200,
        delayMilliseconds: 8_000,
        json: {
          access_token: 'refreshed-access-token',
          refresh_token: 'refreshed-access-token-refresh',
          instance_url: 'https://instance.example.test',
          token_type: 'Bearer',
          issued_at: String(Date.now()),
          expires_in: 3_600,
        },
      },
    ])
    const manager = Connections.create({ store: fixture.store, provider: fixture.provider })
    const owner = manager.credentials('conn_acme')
    let refreshStarted = false
    for (let attempt = 0; attempt < 300; attempt++) {
      if (fixture.server.tokenRequestCount === 2) {
        refreshStarted = true
        break
      }
      await new Promise<void>((resolve) => setTimeout(resolve, 10))
    }
    try {
      expect(refreshStarted).toBe(true)
      await expect(manager.credentials('conn_acme')).rejects.toBeInstanceOf(TemporarilyUnavailable)
      expect(revealSecret((await owner).accessToken)).toBe('refreshed-access-token')
      expect(fixture.server.tokenRequestCount).toBe(2)
    } finally {
      await owner.catch(() => undefined)
    }
  }, 15_000)

  test('requires reauthorization after a known provider rejection', async () => {
    const fixture = await makeFixture([
      tokenResponse('expired-access-token', 0, 1),
      { _tag: 'Response', status: 400, json: { error: 'invalid_grant' } },
    ])
    const manager = Connections.create({ store: fixture.store, provider: fixture.provider })

    await expect(manager.credentials('conn_acme')).rejects.toBeInstanceOf(AuthorizationRequired)
  })

  test('requires intervention when saved credentials cannot be decrypted', async () => {
    const fixture = await makeFixture([tokenResponse('saved-access-token')])
    const wrongStore = SQLite.store({
      database: fixture.database,
      encryptionKey: wrongEncryptionKey,
    })
    const manager = Connections.create({ store: wrongStore, provider: fixture.provider })

    await expect(manager.credentials('conn_acme')).rejects.toMatchObject({
      _tag: 'InterventionRequired',
      cause: { _tag: 'EncryptionFailure' },
    })
  })

  test('keeps uncertain refresh outcomes actionable and does not replay them', async () => {
    const fixture = await makeFixture([
      tokenResponse('expired-access-token', 0, 1),
      { _tag: 'TransportFailure' },
    ])
    const manager = Connections.create({ store: fixture.store, provider: fixture.provider })

    await expect(manager.credentials('conn_acme')).rejects.toBeInstanceOf(InterventionRequired)
    await expect(manager.credentials('conn_acme')).rejects.toBeInstanceOf(InterventionRequired)
    expect(fixture.server.tokenRequestCount).toBe(2)
  })
})
