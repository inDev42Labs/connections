import { Buffer } from 'node:buffer'
import { Effect, Exit, Redacted } from 'effect'
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
  type SalesforceTestServerScript,
  type ScriptedResponse,
} from '../fixtures/salesforce-server.js'

const encryptionKey = Buffer.from(new Uint8Array(32).fill(42)).toString('base64')
const redirectUri = 'https://app.example.test/oauth/salesforce/callback'
const connectionKey = {
  namespace: 'default',
  providerId: 'salesforce',
  connectionId: 'conn_acme',
} as const
const servers = new Set<SalesforceTestServer>()

function tokenResponse(
  accessToken: string,
  refreshToken: string,
  issuedAt = 1_000,
  expiresIn = 3_600,
): ScriptedResponse {
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

async function visitAuthorization(url: string): Promise<string> {
  const response = await fetch(url, { redirect: 'manual' })
  const callbackUrl = response.headers.get('location')
  if (callbackUrl === null) throw new Error('Expected an authorization callback')
  return callbackUrl
}

async function makeFixture(script: SalesforceTestServerScript) {
  const clock = makeTestClock(1_000)
  const driver = makeLifecycleDriver(clock.layer)
  const server = await startSalesforceServer(script)
  servers.add(server)
  const store = makeInMemoryStore({
    encryptor: AesGcm.encryptor({
      key: Configuration.secret(() => encryptionKey),
      keyId: 'replacement-removal-test',
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
  const enrollment = await driver.run(
    connection.startAuthorization(connectionKey.connectionId, {
      binding: 'enrollment-session',
      replace: false,
    }),
  )
  const callbackUrl = await visitAuthorization(enrollment.url)
  await driver.run(
    manager.effect.completeAuthorization({
      callbackUrl,
      binding: 'enrollment-session',
      authorize: () => Effect.runPromise(Effect.void.pipe(Effect.asVoid)),
    }),
  )
  return { clock, connection, driver, manager, server, store }
}

async function prepareReplacement(
  fixture: Awaited<ReturnType<typeof makeFixture>>,
  binding: string,
): Promise<string> {
  const replacement = await fixture.driver.run(
    fixture.connection.startAuthorization(connectionKey.connectionId, { binding, replace: true }),
  )
  return visitAuthorization(replacement.url)
}

function isRemovalFencedCredentialFailure(failure: unknown): boolean {
  if (typeof failure !== 'object' || failure === null || !('_tag' in failure)) return false
  if (failure._tag === 'AuthorizationRequired') return true
  if (failure._tag !== 'InterventionRequired' || !('cause' in failure)) return false
  const cause = failure.cause
  return typeof cause === 'object' && cause !== null && '_tag' in cause && cause._tag === 'Conflict'
}

afterEach(async () => {
  await Promise.all([...servers].map((server) => server.close()))
  servers.clear()
})

describe('Salesforce replacement races with the in-memory store', () => {
  test.each([
    ['acquisition', 'AcquireCredentialOperation'],
    ['dispatch reservation', 'ReserveCredentialOperationDispatch'],
  ] as const)(
    'replacement preparation during refresh %s does not stale the refresh',
    async (_stage, command) => {
      const fixture = await makeFixture({
        authorization: [{ _tag: 'Grant', code: 'enrollment-code' }],
        token: [
          tokenResponse('expired-access-token', 'initial-refresh-token', 0, 1),
          tokenResponse('refreshed-access-token', 'replacement-refresh-token'),
        ],
      })
      const hold = fixture.store.holdNext(command, 'after')
      const refresh = fixture.driver.start(
        fixture.connection.credentialUse(connectionKey.connectionId),
      )

      try {
        await hold.reached
        await fixture.driver.run(
          fixture.connection.startAuthorization(connectionKey.connectionId, {
            binding: 'replacement-session',
            replace: true,
          }),
        )

        expect(fixture.store.unsafeReadConnection(connectionKey)).toMatchObject({
          generation: 0,
          credentialOperation: { kind: 'refresh' },
        })

        hold.release()
        const refreshExit = await refresh.exit
        if (!Exit.isSuccess(refreshExit)) throw new Error('Expected refresh success')

        expect(Redacted.value(refreshExit.value.credentials.accessToken)).toBe(
          'refreshed-access-token',
        )
        expect(fixture.store.unsafeReadConnection(connectionKey)).toMatchObject({
          generation: 0,
          credentialOperation: null,
        })
        expect(fixture.server.tokenRequestCount).toBe(2)
      } finally {
        hold.release()
        refresh.interrupt()
        await refresh.exit
        await fixture.driver.dispose()
      }
    },
  )

  test('replacement completion returns Pending while refresh is unresolved without dispatching an authorization exchange', async () => {
    const fixture = await makeFixture({
      authorization: [
        { _tag: 'Grant', code: 'enrollment-code' },
        { _tag: 'Grant', code: 'replacement-code' },
      ],
      token: [
        tokenResponse('expired-access-token', 'initial-refresh-token', 0, 1),
        tokenResponse('refreshed-access-token', 'replacement-refresh-token'),
      ],
    })
    const callbackUrl = await prepareReplacement(fixture, 'replacement-session')
    const reservation = fixture.store.holdNext('ReserveCredentialOperationDispatch', 'after')
    const refresh = fixture.driver.start(
      fixture.connection.credentialUse(connectionKey.connectionId),
    )

    try {
      await reservation.reached
      const completion = await fixture.driver.run(
        Effect.flip(
          fixture.manager.effect.completeAuthorization({
            callbackUrl,
            binding: 'replacement-session',
            authorize: () => Effect.runPromise(Effect.void.pipe(Effect.asVoid)),
          }),
        ),
      )

      expect(completion).toMatchObject({ reason: 'Pending' })
      expect(fixture.server.tokenRequestCount).toBe(1)
      expect(fixture.store.unsafeReadConnection(connectionKey)?.credentialOperation).toMatchObject({
        kind: 'refresh',
        phase: { _tag: 'DispatchPossible' },
      })

      reservation.release()
      await expect(refresh.exit).resolves.toSatisfy(Exit.isSuccess)
      expect(fixture.server.tokenRequestCount).toBe(2)
      expect(fixture.server.tokenRequests[1]?.form.get('grant_type')).toBe('refresh_token')
    } finally {
      reservation.release()
      refresh.interrupt()
      await refresh.exit
      await fixture.driver.dispose()
    }
  })

  test('successful replacement increments generation and fences its stale superseded callback', async () => {
    const fixture = await makeFixture({
      authorization: [
        { _tag: 'Grant', code: 'enrollment-code' },
        { _tag: 'Grant', code: 'stale-replacement-code' },
        { _tag: 'Grant', code: 'winning-replacement-code' },
      ],
      token: [
        tokenResponse('current-access-token', 'current-refresh-token'),
        tokenResponse('replacement-access-token', 'replacement-refresh-token'),
      ],
    })

    try {
      const staleCallback = await prepareReplacement(fixture, 'stale-session')
      const winningCallback = await prepareReplacement(fixture, 'winning-session')
      await fixture.driver.run(
        fixture.manager.effect.completeAuthorization({
          callbackUrl: winningCallback,
          binding: 'winning-session',
          authorize: () => Effect.runPromise(Effect.void.pipe(Effect.asVoid)),
        }),
      )

      expect(fixture.store.unsafeReadConnection(connectionKey)?.generation).toBe(1)
      let staleApprovals = 0
      const stale = await fixture.driver.run(
        Effect.flip(
          fixture.manager.effect.completeAuthorization({
            callbackUrl: staleCallback,
            binding: 'stale-session',
            authorize: () =>
              Effect.runPromise(Effect.sync(() => staleApprovals++).pipe(Effect.asVoid)),
          }),
        ),
      )
      const credentials = await fixture.driver.run(
        fixture.connection.credentialUse(connectionKey.connectionId),
      )

      expect(stale).toMatchObject({ reason: 'InvalidAttempt' })
      expect(staleApprovals).toBe(0)
      expect(Redacted.value(credentials.credentials.accessToken)).toBe('replacement-access-token')
      expect(fixture.server.tokenRequestCount).toBe(2)
    } finally {
      await fixture.driver.dispose()
    }
  })

  test('unknown replacement remains intervention-required without replay', async () => {
    const fixture = await makeFixture({
      authorization: [
        { _tag: 'Grant', code: 'enrollment-code' },
        { _tag: 'Grant', code: 'unknown-replacement-code' },
      ],
      token: [
        tokenResponse('current-access-token', 'current-refresh-token'),
        { _tag: 'TransportFailure' },
      ],
    })

    try {
      const callbackUrl = await prepareReplacement(fixture, 'replacement-session')
      const completion = await fixture.driver.run(
        Effect.flip(
          fixture.manager.effect.completeAuthorization({
            callbackUrl,
            binding: 'replacement-session',
            authorize: () => Effect.runPromise(Effect.void.pipe(Effect.asVoid)),
          }),
        ),
      )

      expect(completion).toMatchObject({ reason: 'InterventionRequired' })
      expect(fixture.store.unsafeReadConnection(connectionKey)).toMatchObject({
        generation: 0,
        credentialOperation: {
          kind: 'authorization-exchange',
          phase: { _tag: 'InterventionRequired', reason: 'ProviderOutcomeUnknown' },
        },
      })
      await expect(
        fixture.driver.run(
          Effect.flip(fixture.connection.credentialUse(connectionKey.connectionId)),
        ),
      ).resolves.toMatchObject({
        _tag: 'InterventionRequired',
        cause: { _tag: 'ProviderOutcomeUnknown' },
      })

      await fixture.driver.run(fixture.clock.advanceBy(10 * 60 * 1_000))
      await expect(
        fixture.driver.run(
          Effect.flip(fixture.connection.credentialUse(connectionKey.connectionId)),
        ),
      ).resolves.toMatchObject({
        _tag: 'InterventionRequired',
        cause: { _tag: 'ProviderOutcomeUnknown' },
      })
      expect(fixture.server.tokenRequestCount).toBe(2)
    } finally {
      await fixture.driver.dispose()
    }
  })
})

describe('local removal races with the in-memory store', () => {
  test('recovers a committed removal after its acknowledgement is lost', async () => {
    const fixture = await makeFixture({
      authorization: [{ _tag: 'Grant', code: 'enrollment-code' }],
      token: [tokenResponse('initial-access-token', 'initial-refresh-token')],
    })
    fixture.store.loseNextAcknowledgement('RemoveConnection')

    try {
      await fixture.driver.run(fixture.connection.remove(connectionKey.connectionId))

      expect(fixture.store.diagnostics.commands.RemoveConnection).toBe(2)
      await expect(
        fixture.driver.run(fixture.connection.inspect(connectionKey.connectionId)),
      ).resolves.toEqual({
        savedAuthorization: false,
        credentialWork: 'idle',
      })
    } finally {
      await fixture.driver.dispose()
    }
  })

  test('tombstones an unresolved refresh and fences its late completion', async () => {
    const fixture = await makeFixture({
      authorization: [{ _tag: 'Grant', code: 'enrollment-code' }],
      token: [
        tokenResponse('expired-access-token', 'initial-refresh-token', 0, 1),
        tokenResponse('late-refresh-access-token', 'late-refresh-token'),
      ],
    })
    const completion = fixture.store.holdNext('CompleteCredentialOperation', 'before')
    const refresh = fixture.driver.start(
      fixture.connection.credentialUse(connectionKey.connectionId),
    )

    try {
      await completion.reached
      await fixture.driver.run(fixture.connection.remove(connectionKey.connectionId))
      completion.release()

      await expect(refresh.exit).resolves.toSatisfy(
        (exit) =>
          Exit.isFailure(exit) &&
          exit.cause.reasons.some(
            (reason) => reason._tag === 'Fail' && isRemovalFencedCredentialFailure(reason.error),
          ),
      )
      await expect(
        fixture.driver.run(
          Effect.flip(fixture.connection.credentialUse(connectionKey.connectionId)),
        ),
      ).resolves.toMatchObject({ _tag: 'AuthorizationRequired' })
      expect(fixture.store.unsafeReadConnection(connectionKey)).toMatchObject({
        generation: 1,
        authorization: { _tag: 'NotAuthorized' },
        credentialEnvelope: null,
        credentialOperation: null,
      })
      expect(fixture.server.tokenRequestCount).toBe(2)
    } finally {
      completion.release()
      refresh.interrupt()
      await refresh.exit
      await fixture.driver.dispose()
    }
  })

  test('old replacement callbacks cannot interfere with deliberate reenrollment', async () => {
    const fixture = await makeFixture({
      authorization: [
        { _tag: 'Grant', code: 'enrollment-code' },
        { _tag: 'Grant', code: 'stale-replacement-code' },
        { _tag: 'Grant', code: 'reenrollment-code' },
      ],
      token: [
        tokenResponse('initial-access-token', 'initial-refresh-token'),
        tokenResponse('reenrolled-access-token', 'reenrolled-refresh-token'),
      ],
    })

    try {
      const staleCallback = await prepareReplacement(fixture, 'stale-replacement')
      await fixture.driver.run(fixture.connection.remove(connectionKey.connectionId))
      const enrollment = await fixture.driver.run(
        fixture.connection.startAuthorization(connectionKey.connectionId, {
          binding: 'reenrollment',
          replace: false,
        }),
      )
      const enrollmentCallback = await visitAuthorization(enrollment.url)
      await fixture.driver.run(
        fixture.manager.effect.completeAuthorization({
          callbackUrl: enrollmentCallback,
          binding: 'reenrollment',
          authorize: () => Effect.runPromise(Effect.void.pipe(Effect.asVoid)),
        }),
      )

      let staleApprovals = 0
      await expect(
        fixture.driver.run(
          Effect.flip(
            fixture.manager.effect.completeAuthorization({
              callbackUrl: staleCallback,
              binding: 'stale-replacement',
              authorize: () =>
                Effect.runPromise(Effect.sync(() => staleApprovals++).pipe(Effect.asVoid)),
            }),
          ),
        ),
      ).resolves.toMatchObject({ reason: 'InvalidAttempt' })
      const credentials = await fixture.driver.run(
        fixture.connection.credentialUse(connectionKey.connectionId),
      )

      expect(staleApprovals).toBe(0)
      expect(Redacted.value(credentials.credentials.accessToken)).toBe('reenrolled-access-token')
      expect(fixture.store.unsafeReadConnection(connectionKey)?.generation).toBe(1)
      expect(fixture.server.tokenRequestCount).toBe(2)
    } finally {
      await fixture.driver.dispose()
    }
  })

  test('a delayed removal acknowledgement cannot delete later reenrollment', async () => {
    const fixture = await makeFixture({
      authorization: [
        { _tag: 'Grant', code: 'enrollment-code' },
        { _tag: 'Grant', code: 'reenrollment-code' },
      ],
      token: [
        tokenResponse('initial-access-token', 'initial-refresh-token'),
        tokenResponse('reenrolled-access-token', 'reenrolled-refresh-token'),
      ],
    })
    const delayed = fixture.store.holdNext('RemoveConnection', 'after')
    const removal = fixture.driver.start(fixture.connection.remove(connectionKey.connectionId))

    try {
      await delayed.reached
      const enrollment = await fixture.driver.run(
        fixture.connection.startAuthorization(connectionKey.connectionId, {
          binding: 'reenrollment',
          replace: false,
        }),
      )
      const callbackUrl = await visitAuthorization(enrollment.url)
      await fixture.driver.run(
        fixture.manager.effect.completeAuthorization({
          callbackUrl,
          binding: 'reenrollment',
          authorize: () => Effect.runPromise(Effect.void.pipe(Effect.asVoid)),
        }),
      )
      delayed.release()

      await expect(removal.exit).resolves.toSatisfy(
        (exit) =>
          Exit.isFailure(exit) &&
          exit.cause.reasons.some(
            (reason) =>
              reason._tag === 'Fail' &&
              typeof reason.error === 'object' &&
              reason.error !== null &&
              Reflect.get(reason.error, 'reason') === 'Conflict',
          ),
      )
      const credentials = await fixture.driver.run(
        fixture.connection.credentialUse(connectionKey.connectionId),
      )
      expect(Redacted.value(credentials.credentials.accessToken)).toBe('reenrolled-access-token')
      expect(fixture.store.unsafeReadConnection(connectionKey)).toMatchObject({
        generation: 1,
        authorization: { _tag: 'Authorized' },
      })
    } finally {
      delayed.release()
      removal.interrupt()
      await removal.exit
      await fixture.driver.dispose()
    }
  })
})
