import { Buffer } from 'node:buffer'
import { Data, Effect, Exit } from 'effect'
import { afterEach, describe, expect, test } from 'vitest'
import type { ConnectionStore } from '../../src/core/contracts/store.js'
import { Connections } from '../../src/index.js'
import { AesGcm, type EncryptionFailure } from '../../src/encryptors/aes-gcm/index.js'
import { Salesforce } from '../../src/providers/salesforce/index.js'
import { Configuration } from '../../src/configuration/index.js'
import { makeInMemoryStore, type InMemoryStorageFailure } from '../fixtures/in-memory-store.js'
import { makeLifecycleDriver, makeTestClock } from '../fixtures/lifecycle-driver.js'
import {
  startSalesforceServer,
  type SalesforceTestServer,
  type ScriptedResponse,
  type ScriptedTokenOutcome,
} from '../fixtures/salesforce-server.js'

const encryptionKey = Buffer.from(new Uint8Array(32).fill(42)).toString('base64')
const redirectUri = 'https://app.example.test/oauth/salesforce/callback'
const connectionKey = {
  namespace: 'default',
  providerId: 'salesforce',
  connectionId: 'conn_acme',
} as const
const servers = new Set<SalesforceTestServer>()

class TestStorageFailure extends Data.TaggedError('TestStorageFailure')<{}> {}

type CredentialOutcomeTag =
  | 'AuthorizationRequired'
  | 'TemporarilyUnavailable'
  | 'InterventionRequired'

type SafeCauseTag =
  | 'ProviderRejected'
  | 'ProviderFailure'
  | 'ProviderOutcomeUnknown'
  | 'StorageFailure'
  | 'EncryptionFailure'
  | 'Conflict'

function tokenResponse(accessToken: string, issuedAt: number, expiresIn: number): ScriptedResponse {
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

async function makeFixture(
  options: {
    readonly initialCredential?: 'expired' | 'usable'
    readonly refresh?: ReadonlyArray<ScriptedTokenOutcome>
  } = {},
) {
  const clock = makeTestClock(1_000)
  const driver = makeLifecycleDriver(clock.layer)
  const initialCredential = options.initialCredential ?? 'expired'
  const server = await startSalesforceServer({
    authorization: [{ _tag: 'Grant', code: 'authorization-code' }],
    token: [
      initialCredential === 'expired'
        ? tokenResponse('expired-access-token', 0, 1)
        : tokenResponse('usable-access-token', 1_000, 3_600),
      ...(options.refresh ?? []),
    ],
  })
  servers.add(server)
  const backingStore = makeInMemoryStore({
    encryptor: AesGcm.encryptor({
      key: Configuration.secret(() => encryptionKey),
      keyId: 'credential-outcomes-test',
    }),
  })
  let storageUnavailable = false
  const store: ConnectionStore<
    TestStorageFailure | EncryptionFailure | InMemoryStorageFailure,
    never
  > &
    Pick<
      typeof backingStore,
      'diagnostics' | 'holdNext' | 'unsafeReadConnection' | 'unsafeReplaceCredentialEnvelope'
    > = {
    ...backingStore,
    readConnection: (key: Parameters<typeof backingStore.readConnection>[0]) =>
      storageUnavailable ? Effect.fail(new TestStorageFailure()) : backingStore.readConnection(key),
  }
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

  return {
    clock,
    connection: manager.effect,
    driver,
    manager,
    server,
    store,
    makeStorageUnavailable: () => {
      storageUnavailable = true
    },
  }
}

async function enroll(fixture: Awaited<ReturnType<typeof makeFixture>>): Promise<void> {
  const start = await fixture.driver.run(
    fixture.connection.startAuthorization(connectionKey.connectionId, {
      binding: 'trusted-session',
      replace: false,
    }),
  )
  const authorization = await fetch(start.url, { redirect: 'manual' })
  const callbackUrl = authorization.headers.get('location')
  if (callbackUrl === null) throw new Error('Expected an authorization callback')
  await fixture.driver.run(
    fixture.manager.effect.completeAuthorization({
      callbackUrl,
      binding: 'trusted-session',
      authorize: () => Effect.runPromise(Effect.void.pipe(Effect.asVoid)),
    }),
  )
}

function outcomeTags(failure: unknown): {
  readonly outcome: CredentialOutcomeTag | undefined
  readonly cause: SafeCauseTag | undefined
} {
  const outcome =
    typeof failure === 'object' && failure !== null ? Reflect.get(failure, '_tag') : undefined
  const diagnostic =
    typeof failure === 'object' && failure !== null ? Reflect.get(failure, 'cause') : undefined
  const cause =
    typeof diagnostic === 'object' && diagnostic !== null
      ? Reflect.get(diagnostic, '_tag')
      : undefined
  return { outcome, cause }
}

async function eventually(check: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (check()) return
    await new Promise<void>((resolve) => setImmediate(resolve))
  }
  throw new Error('Timed out waiting for deterministic lifecycle progress')
}

afterEach(async () => {
  await Promise.all([...servers].map((server) => server.close()))
  servers.clear()
})

describe('credential outcomes', () => {
  test('reports authorization required when no authorization is saved', async () => {
    const fixture = await makeFixture()

    try {
      const failure = await fixture.driver.run(
        Effect.flip(fixture.connection.credentialUse(connectionKey.connectionId)),
      )

      expect(outcomeTags(failure)).toEqual({
        outcome: 'AuthorizationRequired',
        cause: undefined,
      })
    } finally {
      await fixture.driver.dispose()
    }
  })

  test('reports temporary unavailability when another credential change outlasts the bounded wait', async () => {
    const fixture = await makeFixture({
      refresh: [tokenResponse('refreshed-access-token', 1_000, 3_600)],
    })
    await enroll(fixture)
    const reservation = fixture.store.holdNext('ReserveCredentialOperationDispatch', 'after')
    const owner = fixture.driver.start(fixture.connection.credentialUse(connectionKey.connectionId))

    try {
      await reservation.reached
      const readsBeforeFollower = fixture.store.diagnostics.reads
      const follower = fixture.driver.run(
        Effect.flip(fixture.connection.credentialUse(connectionKey.connectionId)),
      )
      await eventually(() => fixture.store.diagnostics.reads > readsBeforeFollower)
      await fixture.driver.run(fixture.clock.advanceBy(5_000))

      const failure = await follower
      expect(outcomeTags(failure)).toEqual({ outcome: 'TemporarilyUnavailable', cause: undefined })

      reservation.release()
      await owner.exit
    } finally {
      reservation.release()
      owner.interrupt()
      await owner.exit
      await fixture.driver.dispose()
    }
  })

  test('requires intervention with an unknown-outcome cause after transport loss', async () => {
    const fixture = await makeFixture({ refresh: [{ _tag: 'TransportFailure' }] })

    try {
      await enroll(fixture)
      const failure = await fixture.driver.run(
        Effect.flip(fixture.connection.credentialUse(connectionKey.connectionId)),
      )

      expect(outcomeTags(failure)).toEqual({
        outcome: 'InterventionRequired',
        cause: 'ProviderOutcomeUnknown',
      })
    } finally {
      await fixture.driver.dispose()
    }
  })

  test('requires authorization after a known provider rejection', async () => {
    const fixture = await makeFixture({
      refresh: [
        {
          _tag: 'Response',
          status: 400,
          json: { error: 'invalid_grant' },
        },
      ],
    })

    try {
      await enroll(fixture)
      const failure = await fixture.driver.run(
        Effect.flip(fixture.connection.credentialUse(connectionKey.connectionId)),
      )

      expect(outcomeTags(failure)).toEqual({
        outcome: 'AuthorizationRequired',
        cause: undefined,
      })
    } finally {
      await fixture.driver.dispose()
    }
  })

  test('preserves uncertainty when a refresh response cannot establish usable credentials', async () => {
    const fixture = await makeFixture({
      refresh: [
        {
          _tag: 'Response',
          status: 200,
          json: { token_type: 'Bearer' },
        },
      ],
    })

    try {
      await enroll(fixture)
      const failure = await fixture.driver.run(
        Effect.flip(fixture.connection.credentialUse(connectionKey.connectionId)),
      )

      expect(outcomeTags(failure)).toEqual({
        outcome: 'InterventionRequired',
        cause: 'ProviderOutcomeUnknown',
      })
    } finally {
      await fixture.driver.dispose()
    }
  })

  test('reports storage unavailability as temporarily unavailable', async () => {
    const fixture = await makeFixture({ initialCredential: 'usable' })

    try {
      await enroll(fixture)
      fixture.makeStorageUnavailable()
      const failure = await fixture.driver.run(
        Effect.flip(fixture.connection.credentialUse(connectionKey.connectionId)),
      )

      expect(outcomeTags(failure)).toEqual({
        outcome: 'TemporarilyUnavailable',
        cause: 'StorageFailure',
      })
    } finally {
      await fixture.driver.dispose()
    }
  })

  test('requires intervention when persisted credentials cannot authenticate', async () => {
    const fixture = await makeFixture({ initialCredential: 'usable' })

    try {
      await enroll(fixture)
      const snapshot = fixture.store.unsafeReadConnection(connectionKey)
      if (snapshot === null || snapshot.credentialEnvelope === null) {
        throw new Error('Expected protected credentials')
      }
      fixture.store.unsafeReplaceCredentialEnvelope(connectionKey, {
        ...snapshot.credentialEnvelope,
        ciphertext: `${snapshot.credentialEnvelope.ciphertext.slice(0, -2)}AA`,
      })
      const failure = await fixture.driver.run(
        Effect.flip(fixture.connection.credentialUse(connectionKey.connectionId)),
      )

      expect(outcomeTags(failure)).toEqual({
        outcome: 'InterventionRequired',
        cause: 'EncryptionFailure',
      })
    } finally {
      await fixture.driver.dispose()
    }
  })

  test('requires intervention for a stale lifecycle writer', async () => {
    const fixture = await makeFixture({
      refresh: [tokenResponse('stale-access-token', 1_000, 3_600)],
    })
    await enroll(fixture)
    const completion = fixture.store.holdNext('CompleteCredentialOperation', 'before')
    const staleOwner = fixture.driver.start(
      Effect.flip(fixture.connection.credentialUse(connectionKey.connectionId)),
    )

    try {
      await completion.reached
      await fixture.driver.run(fixture.clock.advanceBy(30_000))
      await fixture.driver.run(
        Effect.flip(fixture.connection.credentialUse(connectionKey.connectionId)),
      )
      completion.release()

      const staleExit = await staleOwner.exit
      if (!Exit.isSuccess(staleExit)) throw new Error('Expected the stale failure as a value')
      expect(outcomeTags(staleExit.value)).toEqual({
        outcome: 'InterventionRequired',
        cause: 'Conflict',
      })
    } finally {
      completion.release()
      staleOwner.interrupt()
      await staleOwner.exit
      await fixture.driver.dispose()
    }
  })
})
