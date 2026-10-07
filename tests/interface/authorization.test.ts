import { Buffer } from 'node:buffer'
import { Data, Effect, Redacted } from 'effect'
import { afterEach, describe, expect, test } from 'vitest'
import type { EncryptionContext } from '../../src/core/contracts/encryptor.js'
import {
  AuthorizationFailure,
  Connections,
  type AuthorizationStart,
  type ReadCredentialFailure as CredentialFailure,
} from '../../src/index.js'
import { AesGcm } from '../../src/encryptors/aes-gcm/index.js'
import { Salesforce } from '../../src/providers/salesforce/index.js'
import { Configuration } from '../../src/configuration/index.js'
import { makeInMemoryStore } from '../fixtures/in-memory-store.js'
import { makeLifecycleDriver, makeTestClock } from '../fixtures/lifecycle-driver.js'
import {
  startSalesforceServer,
  type SalesforceTestServer,
  type SalesforceTestServerScript,
} from '../fixtures/salesforce-server.js'

const encryptionKey = Buffer.from(new Uint8Array(32).fill(42)).toString('base64')
const redirectUri = 'https://app.example.test/oauth/salesforce/callback'
const clientSecret = '__connections_client_secret__'
const accessToken = '__connections_access_token__'
const refreshToken = '__connections_refresh_token__'
const servers = new Set<SalesforceTestServer>()

class ApplicationDenied extends Data.TaggedError('ApplicationDenied')<{}> {}

function tokenResponse(tokenSuffix = '') {
  return {
    _tag: 'Response' as const,
    status: 200,
    json: {
      access_token: `${accessToken}${tokenSuffix}`,
      refresh_token: `${refreshToken}${tokenSuffix}`,
      instance_url: `https://instance${tokenSuffix}.example.test`,
      token_type: 'Bearer',
      issued_at: String(Date.now()),
      expires_in: 3600,
    },
  }
}

async function makeFixture(script: SalesforceTestServerScript = {}) {
  const server = await startSalesforceServer(script)
  servers.add(server)
  const store = makeInMemoryStore({
    encryptor: AesGcm.encryptor({
      key: Configuration.secret(() => encryptionKey),
      keyId: 'authorization-test',
    }),
  })
  const provider = Salesforce.oauth({
    clientId: 'client-id',
    clientSecret: Configuration.secret(() => clientSecret),
    redirectUri,
    scopes: ['api', 'refresh_token'],
    loginUrl: server.loginUrl,
  })
  const manager = Connections.create({
    provider,
    store,
  })
  return { manager, server, store }
}

async function visitAuthorization(url: string): Promise<string> {
  const response = await fetch(url, { redirect: 'manual' })
  const location = response.headers.get('location')
  if (location === null) throw new Error('Salesforce fixture did not redirect')
  return location
}

async function completeEnrollment(
  fixture: Awaited<ReturnType<typeof makeFixture>>,
  connectionId: string,
  binding = `binding:${connectionId}`,
) {
  const start = await Effect.runPromise(
    fixture.manager.effect.startAuthorization(connectionId, { binding, replace: false }),
  )
  const callbackUrl = await visitAuthorization(start.url)
  const connection = await Effect.runPromise(
    fixture.manager.effect.completeAuthorization({
      callbackUrl,
      binding,
      authorize: () => Effect.runPromise(Effect.void.pipe(Effect.asVoid)),
    }),
  )
  return { start, callbackUrl, connection }
}

async function authorizationFailure(effect: Effect.Effect<unknown, unknown>) {
  const failure = await Effect.runPromise(Effect.flip(effect))
  if (!(failure instanceof AuthorizationFailure)) throw failure
  return failure
}

async function credentialFailure(effect: Effect.Effect<unknown, CredentialFailure>) {
  return Effect.runPromise(Effect.flip(effect))
}

afterEach(async () => {
  await Promise.all([...servers].map((server) => server.close()))
  servers.clear()
})

describe('Salesforce browser authorization', () => {
  test('application denial and cross-connection authority stop before startAuthorization', async () => {
    const fixture = await makeFixture()
    const allowed = new Set(['conn_acme'])
    const startAsApplication = (
      callerAllowed: boolean,
      connectionId: string,
    ): Effect.Effect<AuthorizationStart, AuthorizationFailure | ApplicationDenied> =>
      callerAllowed && allowed.has(connectionId)
        ? fixture.manager.effect.startAuthorization(connectionId, {
            binding: 'trusted-session',
            replace: false,
          })
        : Effect.fail(new ApplicationDenied())

    await expect(Effect.runPromise(startAsApplication(false, 'conn_acme'))).rejects.toThrow(
      ApplicationDenied,
    )
    await expect(Effect.runPromise(startAsApplication(true, 'conn_globex'))).rejects.toThrow(
      ApplicationDenied,
    )
    expect(fixture.store.diagnostics.reads).toBe(0)
    expect(fixture.store.diagnostics.executions).toBe(0)
    expect(fixture.server.authorizationRequestCount).toBe(0)
    expect(fixture.server.tokenRequestCount).toBe(0)
  })

  test('rejects insecure non-loopback OAuth endpoints before persisting an attempt', async () => {
    const store = makeInMemoryStore()
    const manager = Connections.create({
      provider: Salesforce.oauth({
        clientId: 'client-id',
        clientSecret: Configuration.secret(() => clientSecret),
        redirectUri: 'https://app.example.test/oauth/callback',
        scopes: ['api', 'refresh_token'],
        loginUrl: 'http://provider.example.test',
      }),
      store,
    })

    expect(
      (
        await authorizationFailure(
          manager.effect.startAuthorization('conn_acme', { binding: 'binding', replace: false }),
        )
      ).reason,
    ).toBe('ProviderFailure')
    expect(store.diagnostics.executions).toBe(0)
  })

  test('binds random state, S256 PKCE, stored target, and stored intent to completion', async () => {
    const fixture = await makeFixture({
      authorization: [{ _tag: 'Grant', code: 'authorization-code' }],
      token: [tokenResponse()],
    })
    const binding = 'trusted-session'
    const start = await Effect.runPromise(
      fixture.manager.effect.startAuthorization('conn_acme', { binding, replace: false }),
    )
    const destination = new URL(start.url)

    expect(destination.origin).toBe(new URL(fixture.server.loginUrl).origin)
    expect(destination.pathname).toBe('/services/oauth2/authorize')
    expect(destination.searchParams.get('response_type')).toBe('code')
    expect(destination.searchParams.get('code_challenge_method')).toBe('S256')
    expect(destination.searchParams.get('state')).toMatch(/^[\w-]{43}$/)
    expect(destination.searchParams.get('code_challenge')).toMatch(/^[\w-]{43}$/)
    expect(start.expiresAt).toBeGreaterThan(Date.now())

    const callbackUrl = await visitAuthorization(start.url)
    const approved: Array<{ connectionId: string; intent: string }> = []
    const completed = await Effect.runPromise(
      fixture.manager.effect.completeAuthorization({
        callbackUrl,
        binding,
        authorize: (target) =>
          Effect.runPromise(Effect.sync(() => approved.push(target)).pipe(Effect.asVoid)),
      }),
    )

    expect(completed.connectionId).toBe('conn_acme')
    expect(approved).toEqual([{ connectionId: 'conn_acme', intent: 'enroll' }])
    expect(fixture.server.tokenRequestCount).toBe(1)
    const tokenRequest = fixture.server.tokenRequests[0]?.form
    expect(tokenRequest?.get('grant_type')).toBe('authorization_code')
    expect(tokenRequest?.get('code')).toBe('authorization-code')
    expect(tokenRequest?.get('client_secret')).toBe(clientSecret)
    const verifier = tokenRequest?.get('code_verifier')
    expect(verifier).toMatch(/^[\w-]{43}$/)
    if (verifier === null || verifier === undefined) throw new Error('Expected PKCE verifier')
    const verifierDigest = new Uint8Array(
      await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)),
    )
    const expectedChallenge = Buffer.from(verifierDigest).toString('base64url')
    expect(destination.searchParams.get('code_challenge')).toBe(expectedChallenge)
  })

  test('rejects binding mismatch and an altered callback target before approval or exchange', async () => {
    const fixture = await makeFixture({
      authorization: [
        { _tag: 'Grant', code: 'binding-code' },
        { _tag: 'Grant', code: 'target-code' },
      ],
      token: [tokenResponse()],
    })
    const first = await Effect.runPromise(
      fixture.manager.effect.startAuthorization('conn_acme', {
        binding: 'session-A',
        replace: false,
      }),
    )
    const firstCallback = await visitAuthorization(first.url)
    let approvals = 0

    const mismatch = await authorizationFailure(
      fixture.manager.effect.completeAuthorization({
        callbackUrl: firstCallback,
        binding: 'session-B',
        authorize: () => Effect.runPromise(Effect.sync(() => approvals++).pipe(Effect.asVoid)),
      }),
    )
    expect(mismatch.reason).toBe('InvalidAttempt')

    const second = await Effect.runPromise(
      fixture.manager.effect.startAuthorization('conn_globex', {
        binding: 'session-C',
        replace: false,
      }),
    )
    const altered = new URL(await visitAuthorization(second.url))
    altered.searchParams.set('connectionId', 'conn_acme')
    const alteredFailure = await authorizationFailure(
      fixture.manager.effect.completeAuthorization({
        callbackUrl: altered.toString(),
        binding: 'session-C',
        authorize: () => Effect.runPromise(Effect.sync(() => approvals++).pipe(Effect.asVoid)),
      }),
    )

    expect(alteredFailure.reason).toBe('InvalidCallback')
    expect(approvals).toBe(0)
    expect(fixture.server.tokenRequestCount).toBe(0)
  })

  test('rejects expired, superseded, and reused attempts without another token exchange', async () => {
    const clock = makeTestClock(1_000)
    const driver = makeLifecycleDriver(clock.layer)
    const fixture = await makeFixture({
      authorization: [
        { _tag: 'Grant', code: 'expired-code' },
        { _tag: 'Grant', code: 'superseded-code' },
        { _tag: 'Grant', code: 'winning-code' },
      ],
      token: [tokenResponse()],
    })
    await driver.run(clock.initialize)

    const expired = await driver.run(
      fixture.manager.effect.startAuthorization('conn_expired', {
        binding: 'expired-binding',
        replace: false,
      }),
    )
    const expiredCallback = await visitAuthorization(expired.url)
    await driver.run(clock.advanceBy(10 * 60 * 1000))
    const expiredFailure = await driver.run(
      Effect.flip(
        fixture.manager.effect.completeAuthorization({
          callbackUrl: expiredCallback,
          binding: 'expired-binding',
          authorize: () => Effect.runPromise(Effect.void.pipe(Effect.asVoid)),
        }),
      ),
    )
    expect(expiredFailure).toMatchObject({ reason: 'InvalidAttempt' })

    const first = await driver.run(
      fixture.manager.effect.startAuthorization('conn_acme', {
        binding: 'binding',
        replace: false,
      }),
    )
    const second = await driver.run(
      fixture.manager.effect.startAuthorization('conn_acme', {
        binding: 'binding',
        replace: false,
      }),
    )
    const firstCallback = await visitAuthorization(first.url)
    const secondCallback = await visitAuthorization(second.url)

    expect(
      await driver.run(
        Effect.flip(
          fixture.manager.effect.completeAuthorization({
            callbackUrl: firstCallback,
            binding: 'binding',
            authorize: () => Effect.runPromise(Effect.void.pipe(Effect.asVoid)),
          }),
        ),
      ),
    ).toMatchObject({ reason: 'InvalidAttempt' })
    await expect(
      driver.run(
        fixture.manager.effect.completeAuthorization({
          callbackUrl: secondCallback,
          binding: 'binding',
          authorize: () => Effect.runPromise(Effect.void.pipe(Effect.asVoid)),
        }),
      ),
    ).resolves.toMatchObject({ connectionId: 'conn_acme' })
    expect(
      await driver.run(
        Effect.flip(
          fixture.manager.effect.completeAuthorization({
            callbackUrl: secondCallback,
            binding: 'binding',
            authorize: () => Effect.runPromise(Effect.void.pipe(Effect.asVoid)),
          }),
        ),
      ),
    ).toMatchObject({ reason: 'InvalidAttempt' })
    expect(fixture.server.tokenRequestCount).toBe(1)
    await driver.dispose()
  })

  test('closes a provider-denied attempt without contacting the token endpoint', async () => {
    const fixture = await makeFixture({
      authorization: [{ _tag: 'Deny', error: 'access_denied' }],
    })
    const start = await Effect.runPromise(
      fixture.manager.effect.startAuthorization('conn_acme', {
        binding: 'binding',
        replace: false,
      }),
    )
    const callbackUrl = await visitAuthorization(start.url)

    const denial = await authorizationFailure(
      fixture.manager.effect.completeAuthorization({
        callbackUrl,
        binding: 'binding',
        authorize: () => Effect.runPromise(Effect.void.pipe(Effect.asVoid)),
      }),
    )
    const reuse = await authorizationFailure(
      fixture.manager.effect.completeAuthorization({
        callbackUrl,
        binding: 'binding',
        authorize: () => Effect.runPromise(Effect.void.pipe(Effect.asVoid)),
      }),
    )

    expect(denial.reason).toBe('ProviderDenied')
    expect(reuse.reason).toBe('InvalidAttempt')
    expect(fixture.server.tokenRequestCount).toBe(0)
  })

  test('does not dispatch when the attempt expires during current application approval', async () => {
    const clock = makeTestClock(1_000)
    const driver = makeLifecycleDriver(clock.layer)
    const fixture = await makeFixture({
      authorization: [{ _tag: 'Grant', code: 'authorization-code' }],
      token: [tokenResponse()],
    })
    await driver.run(clock.initialize)

    try {
      const start = await driver.run(
        fixture.manager.effect.startAuthorization('conn_acme', {
          binding: 'binding',
          replace: false,
        }),
      )
      const callbackUrl = await visitAuthorization(start.url)
      const failure = await driver.run(
        Effect.flip(
          fixture.manager.effect.completeAuthorization({
            callbackUrl,
            binding: 'binding',
            authorize: () => driver.run(clock.advanceBy(10 * 60 * 1000)),
          }),
        ),
      )

      expect(failure).toMatchObject({ reason: 'InvalidAttempt' })
      expect(fixture.server.tokenRequestCount).toBe(0)
    } finally {
      await driver.dispose()
    }
  })

  test('does not close a denied attempt that expires during current application approval', async () => {
    const clock = makeTestClock(1_000)
    const driver = makeLifecycleDriver(clock.layer)
    const fixture = await makeFixture({
      authorization: [{ _tag: 'Deny', error: 'access_denied' }],
    })
    await driver.run(clock.initialize)

    try {
      const start = await driver.run(
        fixture.manager.effect.startAuthorization('conn_acme', {
          binding: 'binding',
          replace: false,
        }),
      )
      const callbackUrl = await visitAuthorization(start.url)
      const failure = await driver.run(
        Effect.flip(
          fixture.manager.effect.completeAuthorization({
            callbackUrl,
            binding: 'binding',
            authorize: () => driver.run(clock.advanceBy(10 * 60 * 1000)),
          }),
        ),
      )

      expect(failure).toMatchObject({ reason: 'Conflict' })
      expect(fixture.server.tokenRequestCount).toBe(0)
    } finally {
      await driver.dispose()
    }
  })

  test('does not dispatch when the attempt expires during PKCE decryption', async () => {
    const clock = makeTestClock(1_000)
    const driver = makeLifecycleDriver(clock.layer)
    const server = await startSalesforceServer({
      authorization: [{ _tag: 'Grant', code: 'authorization-code' }],
      token: [tokenResponse()],
    })
    servers.add(server)
    const underlyingStore = makeInMemoryStore({
      encryptor: AesGcm.encryptor({
        key: Configuration.secret(() => encryptionKey),
        keyId: 'delayed-decryption-test',
      }),
    })
    const store = {
      ...underlyingStore,
      unprotect: (envelope: unknown, context: EncryptionContext) =>
        underlyingStore
          .unprotect(envelope, context)
          .pipe(
            Effect.tap(() =>
              context.purpose === 'authorization-pkce'
                ? clock.advanceBy(10 * 60 * 1000)
                : Effect.void,
            ),
          ),
    }
    const manager = Connections.create({
      provider: Salesforce.oauth({
        clientId: 'client-id',
        clientSecret: Configuration.secret(() => clientSecret),
        redirectUri,
        scopes: ['api', 'refresh_token'],
        loginUrl: server.loginUrl,
      }),
      store,
    })
    await driver.run(clock.initialize)

    try {
      const start = await driver.run(
        manager.effect.startAuthorization('conn_acme', { binding: 'binding', replace: false }),
      )
      const callbackUrl = await visitAuthorization(start.url)
      const failure = await driver.run(
        Effect.flip(
          manager.effect.completeAuthorization({
            callbackUrl,
            binding: 'binding',
            authorize: () => Effect.runPromise(Effect.void.pipe(Effect.asVoid)),
          }),
        ),
      )

      expect(failure).toMatchObject({ reason: 'InvalidAttempt' })
      expect(server.tokenRequestCount).toBe(0)
    } finally {
      await driver.dispose()
    }
  })

  test('requires current application approval before admission or provider exchange', async () => {
    const fixture = await makeFixture({
      authorization: [{ _tag: 'Grant', code: 'authorization-code' }],
      token: [tokenResponse()],
    })
    const start = await Effect.runPromise(
      fixture.manager.effect.startAuthorization('conn_acme', {
        binding: 'binding',
        replace: false,
      }),
    )
    const callbackUrl = await visitAuthorization(start.url)

    await expect(
      Effect.runPromise(
        fixture.manager.effect.completeAuthorization({
          callbackUrl,
          binding: 'binding',
          authorize: ({ connectionId }) =>
            Effect.runPromise(
              connectionId === 'conn_globex'
                ? Effect.void
                : Effect.fail(new ApplicationDenied()).pipe(Effect.asVoid),
            ),
        }),
      ),
    ).rejects.toThrow(ApplicationDenied)
    expect(fixture.server.tokenRequestCount).toBe(0)

    await expect(
      Effect.runPromise(
        fixture.manager.effect.completeAuthorization({
          callbackUrl,
          binding: 'binding',
          authorize: () => Effect.runPromise(Effect.void.pipe(Effect.asVoid)),
        }),
      ),
    ).resolves.toMatchObject({ connectionId: 'conn_acme' })
    expect(fixture.server.tokenRequestCount).toBe(1)
  })

  test.each([
    ['expires_in', 'not-a-duration'],
    ['issued_at', 'not-a-timestamp'],
  ] as const)(
    'does not authorize when a present %s token field is invalid',
    async (field, value) => {
      const response = tokenResponse()
      const fixture = await makeFixture({
        authorization: [{ _tag: 'Grant', code: `invalid-${field}` }],
        token: [{ ...response, json: { ...response.json, [field]: value } }],
      })
      const start = await Effect.runPromise(
        fixture.manager.effect.startAuthorization('conn_acme', {
          binding: 'binding',
          replace: false,
        }),
      )
      const callbackUrl = await visitAuthorization(start.url)

      const failure = await authorizationFailure(
        fixture.manager.effect.completeAuthorization({
          callbackUrl,
          binding: 'binding',
          authorize: () => Effect.runPromise(Effect.void.pipe(Effect.asVoid)),
        }),
      )

      expect(failure.reason).toBe('ProviderFailure')
      expect(
        (await credentialFailure(fixture.manager.effect.credentialUse('conn_acme')))._tag,
      ).toBe('AuthorizationRequired')
    },
  )

  test('does not report success when protected credential persistence fails', async () => {
    const fixture = await makeFixture({
      authorization: [{ _tag: 'Grant', code: 'authorization-code' }],
      token: [tokenResponse()],
    })
    fixture.store.failNext('CompleteAuthorizationAttempt')
    const start = await Effect.runPromise(
      fixture.manager.effect.startAuthorization('conn_acme', {
        binding: 'binding',
        replace: false,
      }),
    )
    const callbackUrl = await visitAuthorization(start.url)

    const failure = await authorizationFailure(
      fixture.manager.effect.completeAuthorization({
        callbackUrl,
        binding: 'binding',
        authorize: () => Effect.runPromise(Effect.void.pipe(Effect.asVoid)),
      }),
    )
    const snapshot = fixture.store.unsafeReadConnection({
      namespace: 'default',
      providerId: 'salesforce',
      connectionId: 'conn_acme',
    })

    expect(failure.reason).toBe('StorageFailure')
    expect(snapshot?.authorization).toEqual({ _tag: 'NotAuthorized' })
    expect((await credentialFailure(fixture.manager.effect.credentialUse('conn_acme')))._tag).toBe(
      'AuthorizationRequired',
    )
  })

  test('returns only provider-use credentials for an application-owned client', async () => {
    const fixture = await makeFixture({
      authorization: [{ _tag: 'Grant', code: 'authorization-code' }],
      token: [tokenResponse()],
    })
    await completeEnrollment(fixture, 'conn_acme')

    const credentials = await Effect.runPromise(fixture.manager.effect.credentialUse('conn_acme'))
    const applicationClient = ({ token, url }: { token: string; url: string }) => ({
      authorization: `Bearer ${token}`,
      origin: new URL(url).origin,
    })
    const used = applicationClient({
      token: Redacted.value(credentials.credentials.accessToken),
      url: credentials.credentials.instanceUrl,
    })

    expect(used).toEqual({
      authorization: `Bearer ${accessToken}`,
      origin: 'https://instance.example.test',
    })
    expect(Object.keys(credentials).sort()).toEqual(['credentials', 'reportRejected'])
    expect(Object.keys(credentials.credentials).sort()).toEqual(['accessToken', 'instanceUrl'])
    expect(JSON.stringify(credentials)).not.toContain(accessToken)
    expect(JSON.stringify(credentials)).not.toContain(refreshToken)
    expect(Reflect.has(credentials.credentials, 'refreshToken')).toBe(false)
    expect(Reflect.has(credentials.credentials, 'clientSecret')).toBe(false)
  })

  test('fails closed after persisted-envelope alteration or cross-connection substitution', async () => {
    const fixture = await makeFixture({
      authorization: [
        { _tag: 'Grant', code: 'code-acme' },
        { _tag: 'Grant', code: 'code-globex' },
      ],
      token: [tokenResponse('-acme'), tokenResponse('-globex')],
    })
    await completeEnrollment(fixture, 'conn_acme')
    await completeEnrollment(fixture, 'conn_globex')
    const acmeKey = {
      namespace: 'default',
      providerId: 'salesforce',
      connectionId: 'conn_acme',
    }
    const globexKey = { ...acmeKey, connectionId: 'conn_globex' }
    const acme = fixture.store.unsafeReadConnection(acmeKey)
    const globex = fixture.store.unsafeReadConnection(globexKey)
    if (
      acme === null ||
      globex === null ||
      acme.credentialEnvelope === null ||
      globex.credentialEnvelope === null
    ) {
      throw new Error('Expected protected credentials')
    }

    expect(JSON.stringify(acme)).not.toContain(`${accessToken}-acme`)
    expect(JSON.stringify(acme)).not.toContain(`${refreshToken}-acme`)
    fixture.store.unsafeReplaceCredentialEnvelope(acmeKey, {
      ...acme.credentialEnvelope,
      ciphertext: `${acme.credentialEnvelope.ciphertext.slice(0, -2)}AA`,
    })
    expect(
      await credentialFailure(fixture.manager.effect.credentialUse('conn_acme')),
    ).toMatchObject({ _tag: 'InterventionRequired', cause: { _tag: 'EncryptionFailure' } })

    fixture.store.unsafeReplaceCredentialEnvelope(acmeKey, globex.credentialEnvelope)
    expect(
      await credentialFailure(fixture.manager.effect.credentialUse('conn_acme')),
    ).toMatchObject({ _tag: 'InterventionRequired', cause: { _tag: 'EncryptionFailure' } })
  })
})
