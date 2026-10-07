import { Buffer } from 'node:buffer'
import { Effect, Redacted } from 'effect'
import { afterEach, describe, expect, test } from 'vitest'
import { Connections } from '../../src/index.js'
import { AesGcm } from '../../src/encryptors/aes-gcm/index.js'
import { Salesforce } from '../../src/providers/salesforce/index.js'
import { Configuration } from '../../src/configuration/index.js'
import { makeInMemoryStore } from '../fixtures/in-memory-store.js'
import { makeLifecycleDriver, makeTestClock } from '../fixtures/lifecycle-driver.js'
import {
  startSalesforceServer,
  type SalesforceTestServer,
  type ScriptedResponse,
} from '../fixtures/salesforce-server.js'

const encryptionKey = Buffer.from(new Uint8Array(32).fill(42)).toString('base64')
const redirectUri = 'https://app.example.test/oauth/salesforce/callback'
const servers = new Set<SalesforceTestServer>()

interface TokenResponseOptions {
  readonly accessToken: string
  readonly refreshToken?: string
  readonly issuedAt: number
  readonly expiresIn: number
}

function tokenResponse(options: TokenResponseOptions): ScriptedResponse {
  return {
    _tag: 'Response',
    status: 200,
    json: {
      access_token: options.accessToken,
      ...(options.refreshToken === undefined ? {} : { refresh_token: options.refreshToken }),
      instance_url: 'https://instance.example.test',
      token_type: 'Bearer',
      issued_at: String(options.issuedAt),
      expires_in: options.expiresIn,
    },
  }
}

async function makeFixture(token: readonly ScriptedResponse[]) {
  const server = await startSalesforceServer({
    authorization: [{ _tag: 'Grant', code: 'authorization-code' }],
    token,
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
  return { manager, server, store }
}

async function enroll(
  fixture: Awaited<ReturnType<typeof makeFixture>>,
  run: <A, E>(effect: Effect.Effect<A, E>) => Promise<A> = Effect.runPromise,
): Promise<void> {
  const connection = fixture.manager.effect
  const start = await run(
    connection.startAuthorization('conn_acme', { binding: 'trusted-session', replace: false }),
  )
  const authorization = await fetch(start.url, { redirect: 'manual' })
  const callbackUrl = authorization.headers.get('location')
  if (callbackUrl === null) throw new Error('Expected an authorization callback')
  await run(
    fixture.manager.effect.completeAuthorization({
      callbackUrl,
      binding: 'trusted-session',
      authorize: () => Effect.runPromise(Effect.void.pipe(Effect.asVoid)),
    }),
  )
}

afterEach(async () => {
  await Promise.all([...servers].map((server) => server.close()))
  servers.clear()
})

describe('Salesforce credential refresh with the in-memory store', () => {
  test('returns locally usable credentials without another provider request', async () => {
    const fixture = await makeFixture([
      tokenResponse({
        accessToken: 'usable-access-token',
        refreshToken: 'refresh-token',
        issuedAt: Date.now(),
        expiresIn: 3_600,
      }),
    ])
    await enroll(fixture)

    const first = await Effect.runPromise(fixture.manager.effect.credentialUse('conn_acme'))
    const second = await Effect.runPromise(fixture.manager.effect.credentialUse('conn_acme'))

    expect(Redacted.value(first.credentials.accessToken)).toBe('usable-access-token')
    expect(Redacted.value(second.credentials.accessToken)).toBe('usable-access-token')
    expect(fixture.server.tokenRequestCount).toBe(1)
  })

  test('concurrent callers acquire one refresh and converge on its committed credentials', async () => {
    const fixture = await makeFixture([
      tokenResponse({
        accessToken: 'expired-access-token',
        refreshToken: 'initial-refresh-token',
        issuedAt: 0,
        expiresIn: 1,
      }),
      tokenResponse({
        accessToken: 'converged-access-token',
        refreshToken: 'replacement-refresh-token',
        issuedAt: Date.now(),
        expiresIn: 3_600,
      }),
    ])
    await enroll(fixture)

    const credentials = await Promise.all(
      Array.from({ length: 12 }, () =>
        Effect.runPromise(fixture.manager.effect.credentialUse('conn_acme')),
      ),
    )

    expect(credentials.map(({ credentials }) => Redacted.value(credentials.accessToken))).toEqual(
      Array.from({ length: 12 }, () => 'converged-access-token'),
    )
    expect(fixture.server.tokenRequestCount).toBe(2)
    expect(fixture.server.tokenRequests[1]?.form.get('grant_type')).toBe('refresh_token')
    expect(fixture.server.tokenRequests[1]?.form.get('refresh_token')).toBe('initial-refresh-token')
  })

  test('retries immutable reservation and completion writes without repeating refresh', async () => {
    const fixture = await makeFixture([
      tokenResponse({
        accessToken: 'expired-access-token',
        refreshToken: 'initial-refresh-token',
        issuedAt: 0,
        expiresIn: 1,
      }),
      tokenResponse({
        accessToken: 'acknowledged-access-token',
        refreshToken: 'replacement-refresh-token',
        issuedAt: Date.now(),
        expiresIn: 3_600,
      }),
    ])
    await enroll(fixture)
    fixture.store.loseNextAcknowledgement('ReserveCredentialOperationDispatch')
    fixture.store.loseNextAcknowledgement('CompleteCredentialOperation')

    const credentials = await Effect.runPromise(fixture.manager.effect.credentialUse('conn_acme'))

    expect(Redacted.value(credentials.credentials.accessToken)).toBe('acknowledged-access-token')
    expect(fixture.server.tokenRequestCount).toBe(2)
    expect(fixture.store.diagnostics.commands.ReserveCredentialOperationDispatch).toBe(3)
    expect(fixture.store.diagnostics.commands.CompleteCredentialOperation).toBe(2)
  })

  test('reconciles concurrent followers after a lost completion acknowledgement without another refresh', async () => {
    const fixture = await makeFixture([
      tokenResponse({
        accessToken: 'expired-access-token',
        refreshToken: 'initial-refresh-token',
        issuedAt: 0,
        expiresIn: 1,
      }),
      tokenResponse({
        accessToken: 'reconciled-access-token',
        refreshToken: 'replacement-refresh-token',
        issuedAt: Date.now(),
        expiresIn: 3_600,
      }),
    ])
    await enroll(fixture)
    fixture.store.loseNextAcknowledgement('CompleteCredentialOperation')

    const credentials = await Promise.all(
      Array.from({ length: 4 }, () =>
        Effect.runPromise(fixture.manager.effect.credentialUse('conn_acme')),
      ),
    )

    expect(credentials.map(({ credentials }) => Redacted.value(credentials.accessToken))).toEqual(
      Array.from({ length: 4 }, () => 'reconciled-access-token'),
    )
    expect(fixture.server.tokenRequestCount).toBe(2)
    expect(fixture.store.diagnostics.commands.CompleteCredentialOperation).toBe(2)
  })

  test('uses a replacement refresh token on the next refresh', async () => {
    const clock = makeTestClock(1_000)
    const driver = makeLifecycleDriver(clock.layer)
    const fixture = await makeFixture([
      tokenResponse({
        accessToken: 'expired-access-token',
        refreshToken: 'initial-refresh-token',
        issuedAt: 0,
        expiresIn: 1,
      }),
      tokenResponse({
        accessToken: 'first-refreshed-access-token',
        refreshToken: 'replacement-refresh-token',
        issuedAt: 1_000,
        expiresIn: 1,
      }),
      tokenResponse({
        accessToken: 'second-refreshed-access-token',
        refreshToken: 'later-refresh-token',
        issuedAt: 2_000,
        expiresIn: 1,
      }),
    ])
    await driver.run(clock.initialize)

    try {
      await enroll(fixture, driver.run)
      expect(
        Redacted.value(
          (await driver.run(fixture.manager.effect.credentialUse('conn_acme'))).credentials
            .accessToken,
        ),
      ).toBe('first-refreshed-access-token')
      await driver.run(clock.advanceBy(1_000))
      expect(
        Redacted.value(
          (await driver.run(fixture.manager.effect.credentialUse('conn_acme'))).credentials
            .accessToken,
        ),
      ).toBe('second-refreshed-access-token')

      expect(fixture.server.tokenRequests[1]?.form.get('refresh_token')).toBe(
        'initial-refresh-token',
      )
      expect(fixture.server.tokenRequests[2]?.form.get('refresh_token')).toBe(
        'replacement-refresh-token',
      )
    } finally {
      await driver.dispose()
    }
  })

  test('retains the prior refresh token when Salesforce omits a replacement', async () => {
    const clock = makeTestClock(1_000)
    const driver = makeLifecycleDriver(clock.layer)
    const fixture = await makeFixture([
      tokenResponse({
        accessToken: 'expired-access-token',
        refreshToken: 'retained-refresh-token',
        issuedAt: 0,
        expiresIn: 1,
      }),
      tokenResponse({
        accessToken: 'first-refreshed-access-token',
        issuedAt: 1_000,
        expiresIn: 1,
      }),
      tokenResponse({
        accessToken: 'second-refreshed-access-token',
        issuedAt: 2_000,
        expiresIn: 1,
      }),
    ])
    await driver.run(clock.initialize)

    try {
      await enroll(fixture, driver.run)
      await driver.run(fixture.manager.effect.credentialUse('conn_acme'))
      await driver.run(clock.advanceBy(1_000))
      await driver.run(fixture.manager.effect.credentialUse('conn_acme'))

      expect(fixture.server.tokenRequests[1]?.form.get('refresh_token')).toBe(
        'retained-refresh-token',
      )
      expect(fixture.server.tokenRequests[2]?.form.get('refresh_token')).toBe(
        'retained-refresh-token',
      )
    } finally {
      await driver.dispose()
    }
  })
})
