import { Buffer } from 'node:buffer'
import { Cause, Effect, Exit, Redacted } from 'effect'
import { afterEach, describe, expect, test } from 'vitest'
import { Connections, type ReadCredentialFailure as CredentialFailure } from '../../src/index.js'
import { AesGcm } from '../../src/encryptors/aes-gcm/index.js'
import { Salesforce } from '../../src/providers/salesforce/index.js'
import { Configuration } from '../../src/configuration/index.js'
import { makeInMemoryStore } from '../fixtures/in-memory-store.js'
import {
  makeLifecycleDriver,
  makeTestClock,
  waitForLifecycle as eventually,
} from '../fixtures/lifecycle-driver.js'
import { makeDeterministicClientCredentialsProvider } from '../fixtures/client-credentials-provider.js'
import {
  startSalesforceServer,
  type SalesforceTestServer,
  type ScriptedTokenOutcome,
} from '../fixtures/salesforce-server.js'

const encryptionKey = Buffer.from(new Uint8Array(32).fill(42)).toString('base64')
const redirectUri = 'https://app.example.test/oauth/salesforce/callback'
const servers = new Set<SalesforceTestServer>()

function tokenResponse(
  accessToken: string,
  refreshToken: string,
  issuedAt = 1_000,
  expiresIn = 3_600,
): ScriptedTokenOutcome {
  return {
    _tag: 'Response',
    status: 200,
    json: {
      access_token: accessToken,
      refresh_token: refreshToken,
      instance_url: 'https://instance.example.test',
      token_type: 'Bearer',
      issued_at: String(issuedAt),
      expires_in: expiresIn,
    },
  }
}

async function makeFixture(refresh: readonly ScriptedTokenOutcome[]) {
  const clock = makeTestClock(1_000)
  const driver = makeLifecycleDriver(clock.layer)
  const server = await startSalesforceServer({
    authorization: [{ _tag: 'Grant', code: 'authorization-code' }],
    token: [tokenResponse('expired-access-token', 'initial-refresh-token', 0, 1), ...refresh],
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
  await driver.run(clock.initialize)
  const connection = manager.effect
  const start = await driver.run(
    connection.startAuthorization('conn_acme', { binding: 'trusted-session', replace: false }),
  )
  const authorization = await fetch(start.url, { redirect: 'manual' })
  const callbackUrl = authorization.headers.get('location')
  if (callbackUrl === null) throw new Error('Expected an authorization callback')
  await driver.run(
    manager.effect.completeAuthorization({
      callbackUrl,
      binding: 'trusted-session',
      authorize: () => Effect.runPromise(Effect.void.pipe(Effect.asVoid)),
    }),
  )
  return { clock, connection, driver, manager, server, store }
}

function failure(effect: Effect.Effect<unknown, CredentialFailure>) {
  return Effect.flip(effect)
}

afterEach(async () => {
  await Promise.all([...servers].map((server) => server.close()))
  servers.clear()
})

async function makeClientCredentialsFixture() {
  const clock = makeTestClock(1_000)
  const driver = makeLifecycleDriver(clock.layer)
  const provider = makeDeterministicClientCredentialsProvider()
  const store = makeInMemoryStore()
  const manager = Connections.create({
    provider: provider.provider,
    store,
  })
  await driver.run(clock.initialize)
  const connection = manager.effect
  await driver.run(
    connection.setClientCredentials(
      'conn_acme',
      { source: Redacted.make('source') },
      { replace: false },
    ),
  )
  return { clock, connection, driver, provider, store }
}

describe('Salesforce refresh recovery with the in-memory store', () => {
  test('bounds follower waiting without cancelling or duplicating the owner', async () => {
    const fixture = await makeFixture([
      tokenResponse('refreshed-access-token', 'replacement-refresh-token'),
    ])
    const reservation = fixture.store.holdNext('ReserveCredentialOperationDispatch', 'after')
    const owner = fixture.driver.start(fixture.connection.credentialUse('conn_acme'))

    try {
      await reservation.reached
      const readsBeforeFollower = fixture.store.diagnostics.reads
      const follower = fixture.driver.run(failure(fixture.connection.credentialUse('conn_acme')))
      await eventually(() => fixture.store.diagnostics.reads > readsBeforeFollower)
      await fixture.driver.run(fixture.clock.advanceBy(5_000))

      await expect(follower).resolves.toMatchObject({ _tag: 'TemporarilyUnavailable' })
      expect(fixture.server.tokenRequestCount).toBe(1)

      reservation.release()
      const ownerExit = await owner.exit
      if (!Exit.isSuccess(ownerExit)) throw new Error('Expected refresh owner success')
      expect(Redacted.value(ownerExit.value.credentials.accessToken)).toBe('refreshed-access-token')
      expect(fixture.server.tokenRequestCount).toBe(2)
    } finally {
      reservation.release()
      owner.interrupt()
      await owner.exit
      await fixture.driver.dispose()
    }
  })

  test('cancelling a follower does not cancel its owner or authorize another exchange', async () => {
    const fixture = await makeFixture([
      tokenResponse('refreshed-access-token', 'replacement-refresh-token'),
    ])
    const reservation = fixture.store.holdNext('ReserveCredentialOperationDispatch', 'after')
    const owner = fixture.driver.start(fixture.connection.credentialUse('conn_acme'))

    try {
      await reservation.reached
      const readsBeforeFollower = fixture.store.diagnostics.reads
      const follower = fixture.driver.start(fixture.connection.credentialUse('conn_acme'))
      await eventually(() => fixture.store.diagnostics.reads > readsBeforeFollower)
      follower.interrupt()
      const followerExit = await follower.exit

      expect(Exit.isFailure(followerExit) && Cause.hasInterrupts(followerExit.cause)).toBe(true)
      expect(fixture.server.tokenRequestCount).toBe(1)

      reservation.release()
      await expect(owner.exit).resolves.toSatisfy(Exit.isSuccess)
      expect(fixture.server.tokenRequestCount).toBe(2)
    } finally {
      reservation.release()
      owner.interrupt()
      await owner.exit
      await fixture.driver.dispose()
    }
  })

  test('recovers interrupted renewal when no provider request was dispatched', async () => {
    const fixture = await makeFixture([
      tokenResponse('recovered-access-token', 'replacement-refresh-token'),
    ])
    const acquisition = fixture.store.holdNext('AcquireCredentialOperation', 'after')
    const abandoned = fixture.driver.start(fixture.connection.credentialUse('conn_acme'))

    try {
      await acquisition.reached
      abandoned.interrupt()
      await abandoned.exit
      await fixture.driver.run(fixture.clock.advanceBy(30_000))
      const recovered = await fixture.driver.run(fixture.connection.credentials('conn_acme'))

      expect(Redacted.value(recovered.accessToken)).toBe('recovered-access-token')
      expect(fixture.server.tokenRequestCount).toBe(2)
    } finally {
      acquisition.release()
      abandoned.interrupt()
      await abandoned.exit
      await fixture.driver.dispose()
    }
  })

  test('requires intervention after repeated interruptions exhaust bounded recovery', async () => {
    const fixture = await makeFixture([])

    try {
      for (let owner = 0; owner <= 3; owner++) {
        if (owner > 0) await fixture.driver.run(fixture.clock.advanceBy(30_000))
        const acquisition = fixture.store.holdNext('AcquireCredentialOperation', 'after')
        const execution = fixture.driver.start(fixture.connection.credentialUse('conn_acme'))
        try {
          await acquisition.reached
        } finally {
          execution.interrupt()
          acquisition.release()
          await execution.exit
        }
      }

      await fixture.driver.run(fixture.clock.advanceBy(30_000))
      await expect(
        fixture.driver.run(failure(fixture.connection.credentialUse('conn_acme'))),
      ).resolves.toMatchObject({ _tag: 'InterventionRequired', cause: { _tag: 'Conflict' } })
      await fixture.driver.run(fixture.clock.advanceBy(10 * 60_000))
      await expect(
        fixture.driver.run(failure(fixture.connection.credentialUse('conn_acme'))),
      ).resolves.toMatchObject({ _tag: 'InterventionRequired', cause: { _tag: 'Conflict' } })
      expect(fixture.server.tokenRequestCount).toBe(1)
    } finally {
      await fixture.driver.dispose()
    }
  })

  test('treats a persisted dispatch reservation as non-replayable after owner loss', async () => {
    const fixture = await makeFixture([tokenResponse('must-not-be-dispatched', 'must-not-rotate')])
    const reservation = fixture.store.holdNext('ReserveCredentialOperationDispatch', 'after')
    const abandoned = fixture.driver.start(fixture.connection.credentialUse('conn_acme'))

    try {
      await reservation.reached
      abandoned.interrupt()
      await abandoned.exit
      reservation.release()
      expect(fixture.server.tokenRequestCount).toBe(1)

      await fixture.driver.run(fixture.clock.advanceBy(30_000))
      const uncertain = await fixture.driver.run(
        failure(fixture.connection.credentialUse('conn_acme')),
      )
      expect(uncertain).toMatchObject({
        _tag: 'InterventionRequired',
        cause: { _tag: 'ProviderOutcomeUnknown' },
      })
      await expect(fixture.driver.run(fixture.connection.inspect('conn_acme'))).resolves.toEqual({
        savedAuthorization: true,
        credentialWork: 'intervention-required',
      })
      expect(fixture.server.tokenRequestCount).toBe(1)
    } finally {
      reservation.release()
      abandoned.interrupt()
      await abandoned.exit
      await fixture.driver.dispose()
    }
  })

  test('fences a stale owner after its known response can no longer be committed', async () => {
    const fixture = await makeFixture([tokenResponse('stale-access-token', 'stale-refresh-token')])
    const completion = fixture.store.holdNext('CompleteCredentialOperation', 'before')
    const staleOwner = fixture.driver.start(fixture.connection.credentialUse('conn_acme'))

    try {
      await completion.reached
      await fixture.driver.run(fixture.clock.advanceBy(30_000))
      await expect(
        fixture.driver.run(failure(fixture.connection.credentialUse('conn_acme'))),
      ).resolves.toMatchObject({
        _tag: 'InterventionRequired',
        cause: { _tag: 'ProviderOutcomeUnknown' },
      })
      completion.release()

      const staleExit = await staleOwner.exit
      expect(Exit.isFailure(staleExit)).toBe(true)
      expect(Exit.isFailure(staleExit) && Cause.hasInterrupts(staleExit.cause)).toBe(false)
      await expect(
        fixture.driver.run(failure(fixture.connection.credentialUse('conn_acme'))),
      ).resolves.toMatchObject({
        _tag: 'InterventionRequired',
        cause: { _tag: 'ProviderOutcomeUnknown' },
      })
      expect(fixture.server.tokenRequestCount).toBe(2)
    } finally {
      completion.release()
      staleOwner.interrupt()
      await staleOwner.exit
      await fixture.driver.dispose()
    }
  })

  test('persists distinct known-rejection and unknown-outcome failures without replay', async () => {
    const rejected = await makeFixture([
      { _tag: 'Response', status: 400, json: { error: 'invalid_grant' } },
    ])
    try {
      await expect(
        rejected.driver.run(failure(rejected.connection.credentialUse('conn_acme'))),
      ).resolves.toMatchObject({ _tag: 'AuthorizationRequired' })
      await expect(
        rejected.driver.run(failure(rejected.connection.credentialUse('conn_acme'))),
      ).resolves.toMatchObject({ _tag: 'AuthorizationRequired' })
      expect(rejected.server.tokenRequestCount).toBe(2)
      await expect(rejected.driver.run(rejected.connection.inspect('conn_acme'))).resolves.toEqual({
        savedAuthorization: true,
        credentialWork: 'known-failure',
      })
    } finally {
      await rejected.driver.dispose()
    }

    const unknown = await makeFixture([{ _tag: 'TransportFailure' }])
    try {
      await expect(
        unknown.driver.run(failure(unknown.connection.credentialUse('conn_acme'))),
      ).resolves.toMatchObject({
        _tag: 'InterventionRequired',
        cause: { _tag: 'ProviderOutcomeUnknown' },
      })
      await expect(
        unknown.driver.run(failure(unknown.connection.credentialUse('conn_acme'))),
      ).resolves.toMatchObject({
        _tag: 'InterventionRequired',
        cause: { _tag: 'ProviderOutcomeUnknown' },
      })
      expect(unknown.server.tokenRequestCount).toBe(2)
      await expect(unknown.driver.run(unknown.connection.inspect('conn_acme'))).resolves.toEqual({
        savedAuthorization: true,
        credentialWork: 'intervention-required',
      })
    } finally {
      await unknown.driver.dispose()
    }
  })
})

describe('client credentials recovery', () => {
  test('safely transfers pre-dispatch ownership but never replays dispatch-possible work', async () => {
    const fixture = await makeClientCredentialsFixture()
    const acquisition = fixture.store.holdNext('AcquireCredentialOperation', 'after')
    const abandoned = fixture.driver.start(fixture.connection.credentialUse('conn_acme'))
    try {
      await acquisition.reached
      abandoned.interrupt()
      await abandoned.exit
      acquisition.release()
      await fixture.driver.run(fixture.clock.advanceBy(30_000))
      const recovered = await fixture.driver.run(fixture.connection.credentialUse('conn_acme'))
      expect(Redacted.value(recovered.credentials.token)).toBe('token-1')
      expect(fixture.provider.requests()).toBe(1)

      await fixture.driver.run(recovered.reportRejected())
      const reservation = fixture.store.holdNext('ReserveCredentialOperationDispatch', 'after')
      const owner = fixture.driver.start(fixture.connection.credentialUse('conn_acme'))
      await reservation.reached
      owner.interrupt()
      await owner.exit
      reservation.release()
      await fixture.driver.run(fixture.clock.advanceBy(30_000))
      await expect(
        fixture.driver.run(failure(fixture.connection.credentialUse('conn_acme'))),
      ).resolves.toMatchObject({
        _tag: 'InterventionRequired',
        cause: { _tag: 'ProviderOutcomeUnknown' },
      })
      expect(fixture.provider.requests()).toBe(1)
    } finally {
      acquisition.release()
      await fixture.driver.dispose()
    }
  })

  test('bounds and permits cancellation of followers without cancelling an owner', async () => {
    const fixture = await makeClientCredentialsFixture()
    const reservation = fixture.store.holdNext('ReserveCredentialOperationDispatch', 'after')
    const owner = fixture.driver.start(fixture.connection.credentialUse('conn_acme'))
    try {
      await reservation.reached
      const readsBeforeFollower = fixture.store.diagnostics.reads
      const boundedFollower = fixture.driver.run(
        failure(fixture.connection.credentialUse('conn_acme')),
      )
      await eventually(() => fixture.store.diagnostics.reads > readsBeforeFollower)
      const follower = fixture.driver.start(fixture.connection.credentialUse('conn_acme'))
      await eventually(() => fixture.store.diagnostics.reads > readsBeforeFollower + 1)
      follower.interrupt()
      const followerExit = await follower.exit
      expect(Exit.isFailure(followerExit) && Cause.hasInterrupts(followerExit.cause)).toBe(true)
      await fixture.driver.run(fixture.clock.advanceBy(5_000))
      await expect(boundedFollower).resolves.toMatchObject({ _tag: 'TemporarilyUnavailable' })
      expect(fixture.provider.requests()).toBe(0)
      reservation.release()
      await expect(owner.exit).resolves.toSatisfy(Exit.isSuccess)
      expect(fixture.provider.requests()).toBe(1)
    } finally {
      reservation.release()
      owner.interrupt()
      await owner.exit
      await fixture.driver.dispose()
    }
  })

  test('retains known provider failures and unknown outcomes without replay', async () => {
    const rejected = await makeClientCredentialsFixture()
    try {
      rejected.provider.rejectNext()
      await expect(
        rejected.driver.run(failure(rejected.connection.credentialUse('conn_acme'))),
      ).resolves.toMatchObject({ _tag: 'AuthorizationRequired' })
      await expect(
        rejected.driver.run(failure(rejected.connection.credentialUse('conn_acme'))),
      ).resolves.toMatchObject({ _tag: 'AuthorizationRequired' })
      expect(rejected.provider.requests()).toBe(1)
    } finally {
      await rejected.driver.dispose()
    }

    const failed = await makeClientCredentialsFixture()
    try {
      failed.provider.failNext()
      await expect(
        failed.driver.run(failure(failed.connection.credentialUse('conn_acme'))),
      ).resolves.toMatchObject({
        _tag: 'TemporarilyUnavailable',
        cause: { _tag: 'ProviderFailure' },
      })
      await expect(
        failed.driver.run(failure(failed.connection.credentialUse('conn_acme'))),
      ).resolves.toMatchObject({
        _tag: 'TemporarilyUnavailable',
        cause: { _tag: 'ProviderFailure' },
      })
      expect(failed.provider.requests()).toBe(1)
    } finally {
      await failed.driver.dispose()
    }

    const unknown = await makeClientCredentialsFixture()
    try {
      unknown.provider.outcomeUnknownNext()
      await expect(
        unknown.driver.run(failure(unknown.connection.credentialUse('conn_acme'))),
      ).resolves.toMatchObject({
        _tag: 'InterventionRequired',
        cause: { _tag: 'ProviderOutcomeUnknown' },
      })
      await expect(
        unknown.driver.run(failure(unknown.connection.credentialUse('conn_acme'))),
      ).resolves.toMatchObject({
        _tag: 'InterventionRequired',
        cause: { _tag: 'ProviderOutcomeUnknown' },
      })
      expect(unknown.provider.requests()).toBe(1)
    } finally {
      await unknown.driver.dispose()
    }
  })
})
