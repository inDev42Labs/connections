import { Buffer } from 'node:buffer'
import { Data, Effect, Redacted } from 'effect'
import { afterEach, describe, expect, test } from 'vitest'
import { Connections, type RemovalFailure } from '../../src/index.js'
import { AesGcm } from '../../src/encryptors/aes-gcm/index.js'
import { Salesforce } from '../../src/providers/salesforce/index.js'
import { Configuration } from '../../src/configuration/index.js'
import { makeInMemoryStore } from '../fixtures/in-memory-store.js'
import { startSalesforceServer, type SalesforceTestServer } from '../fixtures/salesforce-server.js'

const encryptionKey = Buffer.from(new Uint8Array(32).fill(42)).toString('base64')
const redirectUri = 'https://app.example.test/oauth/salesforce/callback'
const servers = new Set<SalesforceTestServer>()

class ApplicationDenied extends Data.TaggedError('ApplicationDenied')<{}> {}

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
  test('stops later retrieval without revoking Salesforce or deleting application records', async () => {
    const fixture = await makeFixture()
    const applicationRecords = new Map([['conn_acme', { label: 'Acme production' }]])
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
    expect(applicationRecords.get('conn_acme')).toEqual({ label: 'Acme production' })
    expect(Redacted.value(returnedBeforeRemoval.credentials.accessToken)).toBe(
      'returned-before-removal',
    )
  })

  test('leaves an already empty connection unchanged and skips nonexistent connections', async () => {
    const fixture = await makeFixture()
    const key = { namespace: 'default', providerId: 'salesforce', connectionId: 'conn_acme' }

    await Effect.runPromise(fixture.connection.remove('conn_acme'))
    const removed = fixture.store.unsafeReadConnection(key)
    expect(removed).not.toBeNull()
    await Effect.runPromise(fixture.connection.remove('conn_acme'))
    expect(fixture.store.unsafeReadConnection(key)).toEqual(removed)

    const executionsAfterRemoval = fixture.store.diagnostics.executions
    await Effect.runPromise(fixture.connection.remove('nonexistent'))
    expect(fixture.store.diagnostics.executions).toBe(executionsAfterRemoval)
    await expect(Effect.runPromise(fixture.connection.inspect('conn_acme'))).resolves.toMatchObject(
      {
        savedAuthorization: false,
      },
    )
  })

  test('application denial and cross-connection authority stop before store mutation', async () => {
    const fixture = await makeFixture()
    const allowed = new Set(['conn_acme'])
    const removeAsApplication = (
      callerAllowed: boolean,
      connectionId: string,
    ): Effect.Effect<void, RemovalFailure | ApplicationDenied> =>
      callerAllowed && allowed.has(connectionId)
        ? fixture.manager.effect.remove(connectionId)
        : Effect.fail(new ApplicationDenied())
    const readsBefore = fixture.store.diagnostics.reads
    const executionsBefore = fixture.store.diagnostics.executions
    const providerRequestsBefore = fixture.server.tokenRequestCount

    await expect(Effect.runPromise(removeAsApplication(false, 'conn_acme'))).rejects.toThrow(
      ApplicationDenied,
    )
    await expect(Effect.runPromise(removeAsApplication(true, 'conn_globex'))).rejects.toThrow(
      ApplicationDenied,
    )

    expect(fixture.store.diagnostics.reads).toBe(readsBefore)
    expect(fixture.store.diagnostics.executions).toBe(executionsBefore)
    expect(fixture.server.tokenRequestCount).toBe(providerRequestsBefore)
  })
})
