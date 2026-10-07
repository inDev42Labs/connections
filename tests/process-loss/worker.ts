import assert from 'node:assert/strict'
import { Effect, Fiber, Redacted, Result } from 'effect'
import { TestClock } from 'effect/testing'
import { Connections } from '../../src/index.js'
import {
  PROCESS_CONNECTION_ID,
  makeSqliteProcessClientCredentialsProvider,
  PROCESS_REENROLLMENT_BINDING,
  PROCESS_REPLACEMENT_BINDING,
  SqliteProcessStore,
  makeSqliteProcessProvider,
  makeSqliteProcessSelfClientProvider,
  processReenrollmentCallbackUrl,
  processReplacementCallbackUrl,
} from './sqlite-store.js'
import {
  serializeAuthorizationFailure,
  serializeCredentialFailure,
  serializeRemovalFailure,
  type ProcessCheckpoint,
  type WorkerEvidence,
} from './protocol.js'

type ProcessWorkerAction =
  | 'credentials'
  | 'enroll-code'
  | 'start-replacement'
  | 'complete-replacement'
  | 'remove'
  | 'start-enrollment'
  | 'complete-enrollment'

const [
  directory,
  rawAction,
  requestedCheckpoint,
  rawNow,
  callbackState,
  rawClockAdvance,
  mechanism,
  selfClientCode,
] = process.argv.slice(2)
assert.ok(directory, 'The owned scratch directory is required')
assert.ok(rawNow, 'The controlled clock value is required')
assert.ok(
  rawAction === 'credentials' ||
    rawAction === 'enroll-code' ||
    rawAction === 'start-replacement' ||
    rawAction === 'complete-replacement' ||
    rawAction === 'remove' ||
    rawAction === 'start-enrollment' ||
    rawAction === 'complete-enrollment',
  'A supported worker action is required',
)
const action: ProcessWorkerAction = rawAction
const now = Number(rawNow)
assert.ok(Number.isFinite(now), 'The controlled clock value must be finite')
const clockAdvance = Number(rawClockAdvance ?? 0)
assert.ok(
  Number.isFinite(clockAdvance) && clockAdvance >= 0,
  'The controlled clock advance must be finite and non-negative',
)

assert.ok(
  mechanism === 'oauth' || mechanism === 'client-credentials' || mechanism === 'self-client',
  'A supported mechanism is required',
)

const checkpoint = (point: ProcessCheckpoint): Effect.Effect<void> =>
  point === requestedCheckpoint
    ? Effect.sync(() => {
        emit({ checkpoint: point, pid: process.pid })
      }).pipe(Effect.andThen(Effect.never))
    : Effect.void

const store = new SqliteProcessStore(directory, { checkpoint })
const provider = makeSqliteProcessProvider(directory, checkpoint)
const oauthManager = Connections.create({ provider, store })
const clientManager = Connections.create({
  provider: makeSqliteProcessClientCredentialsProvider(directory, checkpoint),
  store,
})
const oauthConnection = oauthManager.effect
const clientConnection = clientManager.effect
const selfClientManager = Connections.create({
  provider: makeSqliteProcessSelfClientProvider(directory, checkpoint),
  store,
})
const selfClientConnection = selfClientManager.effect

function emit(evidence: WorkerEvidence): void {
  console.log(JSON.stringify(evidence))
}

async function runResult<A, E>(effect: Effect.Effect<A, E>, advanceBy = 0) {
  return Effect.runPromise(
    Effect.gen(function* () {
      yield* TestClock.setTime(now)
      if (advanceBy === 0) return yield* Effect.result(effect)

      const execution = yield* Effect.result(effect).pipe(Effect.forkChild)
      yield* TestClock.adjust(advanceBy)
      return yield* Fiber.join(execution)
    }).pipe(Effect.provide(TestClock.layer())),
  )
}

try {
  switch (action) {
    case 'credentials': {
      if (mechanism === 'self-client') {
        const result = await runResult(
          selfClientConnection.credentialUse(PROCESS_CONNECTION_ID),
          clockAdvance,
        )
        emit(
          Result.isSuccess(result)
            ? {
                outcome: 'credentials',
                accessToken: Redacted.value(result.success.credentials.accessToken),
                pid: process.pid,
              }
            : {
                outcome: 'credential-failure',
                failure: serializeCredentialFailure(result.failure),
                pid: process.pid,
              },
        )
      } else if (mechanism === 'oauth') {
        const result = await runResult(
          oauthConnection.credentialUse(PROCESS_CONNECTION_ID),
          clockAdvance,
        )
        emit(
          Result.isSuccess(result)
            ? {
                outcome: 'credentials',
                accessToken: Redacted.value(result.success.credentials.accessToken),
                pid: process.pid,
              }
            : {
                outcome: 'credential-failure',
                failure: serializeCredentialFailure(result.failure),
                pid: process.pid,
              },
        )
      } else {
        const result = await runResult(
          clientConnection.credentialUse(PROCESS_CONNECTION_ID),
          clockAdvance,
        )
        emit(
          Result.isSuccess(result)
            ? {
                outcome: 'credentials',
                accessToken: Redacted.value(result.success.credentials.accessToken),
                pid: process.pid,
              }
            : {
                outcome: 'credential-failure',
                failure: serializeCredentialFailure(result.failure),
                pid: process.pid,
              },
        )
      }
      break
    }

    case 'enroll-code': {
      assert.equal(mechanism, 'self-client', 'Self Client enrollment requires its provider')
      assert.ok(selfClientCode, 'Self Client enrollment requires a fake code')
      let approvals = 0
      const result = await runResult(
        selfClientConnection.enrollCode(PROCESS_CONNECTION_ID, {
          code: selfClientCode,
          authorize: () => Effect.runPromise(Effect.sync(() => approvals++).pipe(Effect.asVoid)),
          replace: false,
        }),
      )
      if (Result.isFailure(result)) {
        emit({
          outcome: 'authorization-failure',
          reason: serializeAuthorizationFailure(result.failure),
          pid: process.pid,
        })
      } else {
        assert.equal(approvals, 1, 'The operator approval callback must run exactly once')
        emit({ outcome: 'self-client-enrolled', approved: true, pid: process.pid })
      }
      break
    }

    case 'remove': {
      const result = await runResult(
        mechanism === 'oauth'
          ? oauthConnection.remove(PROCESS_CONNECTION_ID)
          : clientConnection.remove(PROCESS_CONNECTION_ID),
      )
      emit(
        Result.isSuccess(result)
          ? { outcome: 'removed', pid: process.pid }
          : {
              outcome: 'removal-failure',
              reason: serializeRemovalFailure(result.failure),
              pid: process.pid,
            },
      )
      break
    }

    case 'start-replacement':
    case 'start-enrollment': {
      assert.equal(mechanism, 'oauth', 'Authorization actions require OAuth')
      const enrollment = action === 'start-enrollment'
      const result = await runResult(
        oauthConnection.startAuthorization(PROCESS_CONNECTION_ID, {
          binding: enrollment ? PROCESS_REENROLLMENT_BINDING : PROCESS_REPLACEMENT_BINDING,
          replace: !enrollment,
        }),
      )
      if (Result.isFailure(result)) {
        emit({
          outcome: 'authorization-failure',
          reason: serializeAuthorizationFailure(result.failure),
          pid: process.pid,
        })
        break
      }
      const state = new URL(result.success.url).searchParams.get('state')
      assert.ok(state, 'The authorization URL must contain state')
      emit({ outcome: 'authorization-start', state, pid: process.pid })
      break
    }

    case 'complete-replacement':
    case 'complete-enrollment': {
      assert.equal(mechanism, 'oauth', 'Authorization actions require OAuth')
      const enrollment = action === 'complete-enrollment'
      assert.ok(callbackState, 'Authorization completion requires callback state')
      const result = await runResult(
        oauthManager.effect.completeAuthorization({
          callbackUrl: enrollment
            ? processReenrollmentCallbackUrl(callbackState)
            : processReplacementCallbackUrl(callbackState),
          binding: enrollment ? PROCESS_REENROLLMENT_BINDING : PROCESS_REPLACEMENT_BINDING,
          authorize: () => Effect.runPromise(Effect.void.pipe(Effect.asVoid)),
        }),
      )
      emit(
        Result.isSuccess(result)
          ? {
              outcome: 'authorization-completed',
              connectionId: result.success.connectionId,
              pid: process.pid,
            }
          : {
              outcome: 'authorization-failure',
              reason: serializeAuthorizationFailure(result.failure),
              pid: process.pid,
            },
      )
      break
    }
  }
} finally {
  store.close()
}
