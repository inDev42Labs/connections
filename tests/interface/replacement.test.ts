import { Buffer } from 'node:buffer'
import { Data, Effect, Redacted } from 'effect'
import { afterEach, describe, expect, test } from 'vitest'
import { AuthorizationFailure, Connections, type AuthorizationStart } from '../../src/index.js'
import { AesGcm } from '../../src/encryptors/aes-gcm/index.js'
import { Salesforce } from '../../src/providers/salesforce/index.js'
import { Configuration } from '../../src/configuration/index.js'
import { makeInMemoryStore } from '../fixtures/in-memory-store.js'
import { makeLifecycleDriver, makeTestClock } from '../fixtures/lifecycle-driver.js'
import {
  startSalesforceServer,
  type SalesforceTestServer,
  type SalesforceTestServerScript,
  type ScriptedResponse,
} from '../fixtures/salesforce-server.js'

const encryptionKey = Buffer.from(new Uint8Array(32).fill(42)).toString('base64')
const redirectUri = 'https://app.example.test/oauth/salesforce/callback'
const servers = new Set<SalesforceTestServer>()

class ApplicationDenied extends Data.TaggedError('ApplicationDenied')<{}> {}

function tokenResponse(accessToken: string): ScriptedResponse {
  return {
    _tag: 'Response',
    status: 200,
    json: {
      access_token: accessToken,
      refresh_token: `${accessToken}-refresh`,
      instance_url: 'https://instance.example.test',
      token_type: 'Bearer',
      expires_in: 3_600,
    },
  }
}

async function makeFixture(script: SalesforceTestServerScript) {
  const server = await startSalesforceServer(script)
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
  return { manager, server, store }
}

async function visitAuthorization(url: string): Promise<string> {
  const response = await fetch(url, { redirect: 'manual' })
  const callbackUrl = response.headers.get('location')
  if (callbackUrl === null) throw new Error('Expected an authorization callback')
  return callbackUrl
}

async function enroll(
  fixture: Awaited<ReturnType<typeof makeFixture>>,
  run: <A, E>(effect: Effect.Effect<A, E>) => Promise<A> = Effect.runPromise,
) {
  const connection = fixture.manager.effect
  const start = await run(
    connection.startAuthorization('conn_acme', { binding: 'enrollment-session', replace: false }),
  )
  const callbackUrl = await visitAuthorization(start.url)
  await run(
    fixture.manager.effect.completeAuthorization({
      callbackUrl,
      binding: 'enrollment-session',
      authorize: () => Effect.runPromise(Effect.void.pipe(Effect.asVoid)),
    }),
  )
  return connection
}

async function authorizationFailure(effect: Effect.Effect<unknown, unknown>) {
  const failure = await Effect.runPromise(Effect.flip(effect))
  if (!(failure instanceof AuthorizationFailure)) throw failure
  return failure
}

afterEach(async () => {
  await Promise.all([...servers].map((server) => server.close()))
  servers.clear()
})

describe('Salesforce authorization replacement interface', () => {
  test('application denial and cross-connection authority stop before replacement start', async () => {
    const fixture = await makeFixture({
      authorization: [{ _tag: 'Grant', code: 'enrollment-code' }],
      token: [tokenResponse('current-access-token')],
    })
    await enroll(fixture)
    const allowed = new Set(['conn_acme'])
    const startAsApplication = (
      callerAllowed: boolean,
      connectionId: string,
    ): Effect.Effect<AuthorizationStart, AuthorizationFailure | ApplicationDenied> =>
      callerAllowed && allowed.has(connectionId)
        ? fixture.manager.effect.startAuthorization(connectionId, {
            binding: 'replacement-session',
            replace: true,
          })
        : Effect.fail(new ApplicationDenied())
    const readsBefore = fixture.store.diagnostics.reads
    const executionsBefore = fixture.store.diagnostics.executions
    const authorizationRequestsBefore = fixture.server.authorizationRequestCount
    const tokenRequestsBefore = fixture.server.tokenRequestCount

    await expect(Effect.runPromise(startAsApplication(false, 'conn_acme'))).rejects.toThrow(
      ApplicationDenied,
    )
    await expect(Effect.runPromise(startAsApplication(true, 'conn_globex'))).rejects.toThrow(
      ApplicationDenied,
    )

    expect(fixture.store.diagnostics.reads).toBe(readsBefore)
    expect(fixture.store.diagnostics.executions).toBe(executionsBefore)
    expect(fixture.server.authorizationRequestCount).toBe(authorizationRequestsBefore)
    expect(fixture.server.tokenRequestCount).toBe(tokenRequestsBefore)
  })

  test('rejects enrollment against saved authorization unless replacement intent is explicit', async () => {
    const fixture = await makeFixture({
      authorization: [{ _tag: 'Grant', code: 'enrollment-code' }],
      token: [tokenResponse('current-access-token')],
    })
    const connection = await enroll(fixture)

    expect(
      (
        await authorizationFailure(
          connection.startAuthorization('conn_acme', { binding: 'second-session', replace: false }),
        )
      ).reason,
    ).toBe('Conflict')
    await expect(
      Effect.runPromise(
        connection.startAuthorization('conn_acme', { binding: 'second-session', replace: true }),
      ),
    ).resolves.toMatchObject({ url: expect.any(String), expiresAt: expect.any(Number) })
  })

  test('keeps current credentials usable while replacement is prepared', async () => {
    const fixture = await makeFixture({
      authorization: [{ _tag: 'Grant', code: 'enrollment-code' }],
      token: [tokenResponse('current-access-token')],
    })
    const connection = await enroll(fixture)

    await Effect.runPromise(
      connection.startAuthorization('conn_acme', { binding: 'replacement-session', replace: true }),
    )
    const credentials = await Effect.runPromise(connection.credentialUse('conn_acme'))

    expect(Redacted.value(credentials.credentials.accessToken)).toBe('current-access-token')
    expect(fixture.server.tokenRequestCount).toBe(1)
  })

  test('keeps current credentials usable when replacement is abandoned in the browser', async () => {
    const fixture = await makeFixture({
      authorization: [
        { _tag: 'Grant', code: 'enrollment-code' },
        { _tag: 'Grant', code: 'abandoned-replacement-code' },
      ],
      token: [tokenResponse('current-access-token')],
    })
    const connection = await enroll(fixture)
    const replacement = await Effect.runPromise(
      connection.startAuthorization('conn_acme', { binding: 'replacement-session', replace: true }),
    )

    await visitAuthorization(replacement.url)
    const credentials = await Effect.runPromise(connection.credentialUse('conn_acme'))

    expect(Redacted.value(credentials.credentials.accessToken)).toBe('current-access-token')
    expect(fixture.server.authorizationRequestCount).toBe(2)
    expect(fixture.server.tokenRequestCount).toBe(1)
  })

  test('keeps current credentials usable after prepared replacement expiry', async () => {
    const clock = makeTestClock(1_000)
    const driver = makeLifecycleDriver(clock.layer)
    const fixture = await makeFixture({
      authorization: [{ _tag: 'Grant', code: 'enrollment-code' }],
      token: [tokenResponse('current-access-token')],
    })
    await driver.run(clock.initialize)

    try {
      const connection = await enroll(fixture, driver.run)
      await driver.run(
        connection.startAuthorization('conn_acme', {
          binding: 'replacement-session',
          replace: true,
        }),
      )
      await driver.run(clock.advanceBy(10 * 60 * 1_000))
      const credentials = await driver.run(connection.credentialUse('conn_acme'))

      expect(Redacted.value(credentials.credentials.accessToken)).toBe('current-access-token')
      expect(fixture.server.tokenRequestCount).toBe(1)
    } finally {
      await driver.dispose()
    }
  })

  test('rejects a superseded replacement callback and keeps current credentials usable', async () => {
    const fixture = await makeFixture({
      authorization: [
        { _tag: 'Grant', code: 'enrollment-code' },
        { _tag: 'Grant', code: 'superseded-replacement-code' },
      ],
      token: [tokenResponse('current-access-token')],
    })
    const connection = await enroll(fixture)
    const superseded = await Effect.runPromise(
      connection.startAuthorization('conn_acme', { binding: 'replacement-session', replace: true }),
    )
    const supersededCallback = await visitAuthorization(superseded.url)
    await Effect.runPromise(
      connection.startAuthorization('conn_acme', { binding: 'replacement-session', replace: true }),
    )
    let approvals = 0

    expect(
      (
        await authorizationFailure(
          fixture.manager.effect.completeAuthorization({
            callbackUrl: supersededCallback,
            binding: 'replacement-session',
            authorize: () => Effect.runPromise(Effect.sync(() => approvals++).pipe(Effect.asVoid)),
          }),
        )
      ).reason,
    ).toBe('InvalidAttempt')
    const credentials = await Effect.runPromise(connection.credentialUse('conn_acme'))

    expect(approvals).toBe(0)
    expect(Redacted.value(credentials.credentials.accessToken)).toBe('current-access-token')
    expect(fixture.server.tokenRequestCount).toBe(1)
  })

  test('keeps the connection ID and returns replacement credentials after success', async () => {
    const fixture = await makeFixture({
      authorization: [
        { _tag: 'Grant', code: 'enrollment-code' },
        { _tag: 'Grant', code: 'replacement-code' },
      ],
      token: [tokenResponse('current-access-token'), tokenResponse('replacement-access-token')],
    })
    const connection = await enroll(fixture)
    const replacement = await Effect.runPromise(
      connection.startAuthorization('conn_acme', { binding: 'replacement-session', replace: true }),
    )
    const callbackUrl = await visitAuthorization(replacement.url)
    const approved: Array<{ connectionId: string; intent: string }> = []

    const completed = await Effect.runPromise(
      fixture.manager.effect.completeAuthorization({
        callbackUrl,
        binding: 'replacement-session',
        authorize: (target) =>
          Effect.runPromise(Effect.sync(() => approved.push(target)).pipe(Effect.asVoid)),
      }),
    )
    const credentials = await Effect.runPromise(connection.credentialUse(completed.connectionId))

    expect(completed.connectionId).toBe('conn_acme')
    expect(approved).toEqual([{ connectionId: 'conn_acme', intent: 'replace' }])
    expect(Redacted.value(credentials.credentials.accessToken)).toBe('replacement-access-token')
    expect(fixture.server.tokenRequestCount).toBe(2)
  })

  test('keeps a transport-unknown replacement intervention-required without replay', async () => {
    const clock = makeTestClock(1_000)
    const driver = makeLifecycleDriver(clock.layer)
    const fixture = await makeFixture({
      authorization: [
        { _tag: 'Grant', code: 'enrollment-code' },
        { _tag: 'Grant', code: 'unknown-replacement-code' },
      ],
      token: [tokenResponse('current-access-token'), { _tag: 'TransportFailure' }],
    })
    await driver.run(clock.initialize)

    try {
      const connection = await enroll(fixture, driver.run)
      const replacement = await driver.run(
        connection.startAuthorization('conn_acme', {
          binding: 'replacement-session',
          replace: true,
        }),
      )
      const callbackUrl = await visitAuthorization(replacement.url)

      await expect(
        driver.run(
          fixture.manager.effect.completeAuthorization({
            callbackUrl,
            binding: 'replacement-session',
            authorize: () => Effect.runPromise(Effect.void.pipe(Effect.asVoid)),
          }),
        ),
      ).rejects.toMatchObject({ _tag: 'AuthorizationFailure' })
      await expect(
        driver.run(Effect.flip(connection.credentialUse('conn_acme'))),
      ).resolves.toMatchObject({
        _tag: 'InterventionRequired',
        cause: { _tag: 'ProviderOutcomeUnknown' },
      })

      await driver.run(clock.advanceBy(10 * 60 * 1_000))
      await expect(
        driver.run(Effect.flip(connection.credentialUse('conn_acme'))),
      ).resolves.toMatchObject({
        _tag: 'InterventionRequired',
        cause: { _tag: 'ProviderOutcomeUnknown' },
      })
      expect(fixture.server.tokenRequestCount).toBe(2)
    } finally {
      await driver.dispose()
    }
  })
})
