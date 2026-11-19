import { Buffer } from 'node:buffer'
import { Effect, Redacted } from 'effect'
import { afterEach, describe, expect, test } from 'vitest'
import { Connections } from '../../src/index.js'
import { AesGcm } from '../../src/encryptors/aes-gcm/index.js'
import { Salesforce } from '../../src/providers/salesforce/index.js'
import { Configuration } from '../../src/configuration/index.js'
import { makeInMemoryStore } from '../fixtures/in-memory-store.js'
import { startSalesforceServer, type SalesforceTestServer } from '../fixtures/salesforce-server.js'

const encryptionKey = Buffer.from(new Uint8Array(32).fill(42)).toString('base64')
const redirectUri = 'https://app.example.test/oauth/salesforce/callback'
const servers = new Set<SalesforceTestServer>()

async function makeFixture() {
  const server = await startSalesforceServer({
    authorization: [{ _tag: 'Grant', code: 'authorization-code' }],
    token: [
      {
        _tag: 'Response',
        status: 200,
        json: {
          access_token: 'returned-before-removal',
          refresh_token: 'stored-refresh-token',
          instance_url: 'https://instance.example.test',
          token_type: 'Bearer',
          issued_at: String(Date.now()),
          expires_in: 3_600,
        },
      },
    ],
  })
  servers.add(server)
  const store = makeInMemoryStore({
    encryptor: AesGcm.encryptor({
      key: Configuration.secret(() => encryptionKey),
      keyId: 'default',
    }),
  })
  const manager = Connections.create({
    provider: Salesforce.oauth({
      clientId: 'client-id',
      clientSecret: Configuration.secret(() => 'client-secret'),
      redirectUri,
      scopes: ['api', 'refresh_token'],
      loginUrl: server.loginUrl,
    }),
    store,
  })
  const connection = manager.effect
  const start = await Effect.runPromise(
    connection.startAuthorization('conn_acme', { binding: 'trusted-session', replace: false }),
  )
  const authorization = await fetch(start.url, { redirect: 'manual' })
  const callbackUrl = authorization.headers.get('location')
  if (callbackUrl === null) throw new Error('Expected an authorization callback')
  await Effect.runPromise(
    manager.effect.completeAuthorization({
      callbackUrl,
      binding: 'trusted-session',
      authorize: () => Effect.runPromise(Effect.void.pipe(Effect.asVoid)),
    }),
  )
  return { connection, manager, server, store }
}

afterEach(async () => {
  await Promise.all([...servers].map((server) => server.close()))
  servers.clear()
})

describe('local credential removal interface', () => {
  test('stops later retrieval without revoking Salesforce or recalling credentials already returned', async () => {
    const fixture = await makeFixture()
    const returnedBeforeRemoval = await Effect.runPromise(
      fixture.connection.credentialUse('conn_acme'),
    )
    const providerRequestsBefore = fixture.server.tokenRequestCount

    await Effect.runPromise(fixture.connection.remove('conn_acme'))

    await expect(
      Effect.runPromise(Effect.flip(fixture.connection.credentialUse('conn_acme'))),
    ).resolves.toMatchObject({ _tag: 'AuthorizationRequired' })
    await expect(Effect.runPromise(fixture.connection.inspect('conn_acme'))).resolves.toEqual({
      savedAuthorization: false,
      credentialWork: 'idle',
    })
    expect(fixture.server.tokenRequestCount).toBe(providerRequestsBefore)
    expect(Redacted.value(returnedBeforeRemoval.credentials.accessToken)).toBe(
      'returned-before-removal',
    )
  })

  test('repeated removal and removal of missing connections are harmless', async () => {
    const fixture = await makeFixture()
    await Effect.runPromise(fixture.connection.remove('conn_acme'))
    await Effect.runPromise(fixture.connection.remove('conn_acme'))
    await Effect.runPromise(fixture.connection.remove('nonexistent'))

    for (const id of ['conn_acme', 'nonexistent']) {
      await expect(Effect.runPromise(fixture.connection.inspect(id))).resolves.toEqual({
        savedAuthorization: false,
        credentialWork: 'idle',
      })
      await expect(Effect.runPromise(fixture.connection.credentials(id))).rejects.toMatchObject({
        _tag: 'AuthorizationRequired',
      })
    }
    expect(fixture.server.tokenRequestCount).toBe(1)
  })
})
