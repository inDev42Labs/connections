import { Buffer } from 'node:buffer'
import { Data, Effect, Redacted } from 'effect'
import { afterEach, describe, expect, test } from 'vitest'
import { Connections, type ReadCredentialFailure as CredentialFailure } from '../../src/index.js'
import { AesGcm } from '../../src/encryptors/aes-gcm/index.js'
import { Salesforce, type SalesforceCredentials } from '../../src/providers/salesforce/index.js'
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
          access_token: 'retrieved-access-token',
          refresh_token: 'stored-refresh-token',
          instance_url: 'https://instance.example.test',
          token_type: 'Bearer',
          issued_at: String(Date.now()),
          expires_in: 3_600,
        },
      },
      {
        _tag: 'Response',
        status: 200,
        json: {
          access_token: 'replacement-access-token',
          refresh_token: 'replacement-refresh-token',
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

describe('Salesforce credential retrieval interface', () => {
  test('returns local credential material without promising live resource acceptance', async () => {
    const fixture = await makeFixture()
    const credentials = await Effect.runPromise(fixture.connection.credentialUse('conn_acme'))
    const presentedTokens: string[] = []
    const applicationOwnedResourceServer = (input: SalesforceCredentials): Response => {
      presentedTokens.push(Redacted.value(input.accessToken))
      return new Response(null, { status: 401 })
    }

    const resourceResponse = applicationOwnedResourceServer(credentials.credentials)

    expect(resourceResponse.status).toBe(401)
    expect(presentedTokens).toEqual(['retrieved-access-token'])
    expect(Object.keys(credentials.credentials).sort()).toEqual(['accessToken', 'instanceUrl'])
    expect(typeof credentials.reportRejected).toBe('function')
    expect(fixture.server.tokenRequestCount).toBe(1)
  })

  test('refreshes after rejection without allowing a stale report to invalidate the replacement', async () => {
    const fixture = await makeFixture()
    const first = await Effect.runPromise(fixture.connection.credentialUse('conn_acme'))

    await Effect.runPromise(first.reportRejected())
    const replacement = await Effect.runPromise(fixture.connection.credentialUse('conn_acme'))
    await Effect.runPromise(first.reportRejected())
    const current = await Effect.runPromise(fixture.connection.credentialUse('conn_acme'))

    expect(Redacted.value(replacement.credentials.accessToken)).toBe('replacement-access-token')
    expect(Redacted.value(current.credentials.accessToken)).toBe('replacement-access-token')
    expect(fixture.server.tokenRequestCount).toBe(2)
  })

  test('application denial and cross-connection authority stop before credential workflow', async () => {
    const fixture = await makeFixture()
    const allowed = new Set(['conn_acme'])
    const credentialsAsApplication = (
      callerAllowed: boolean,
      connectionId: string,
    ): Effect.Effect<
      import('../../src/index.js').CredentialUse<SalesforceCredentials>,
      CredentialFailure | ApplicationDenied
    > =>
      callerAllowed && allowed.has(connectionId)
        ? fixture.manager.effect.credentialUse(connectionId)
        : Effect.fail(new ApplicationDenied())
    const readsBefore = fixture.store.diagnostics.reads
    const executionsBefore = fixture.store.diagnostics.executions
    const providerRequestsBefore = fixture.server.tokenRequestCount

    await expect(Effect.runPromise(credentialsAsApplication(false, 'conn_acme'))).rejects.toThrow(
      ApplicationDenied,
    )
    await expect(Effect.runPromise(credentialsAsApplication(true, 'conn_globex'))).rejects.toThrow(
      ApplicationDenied,
    )

    expect(fixture.store.diagnostics.reads).toBe(readsBefore)
    expect(fixture.store.diagnostics.executions).toBe(executionsBefore)
    expect(fixture.server.tokenRequestCount).toBe(providerRequestsBefore)
  })
})
