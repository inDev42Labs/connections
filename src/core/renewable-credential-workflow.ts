import { Clock, Effect, Result } from 'effect'
import type { EncryptionContext } from './contracts/encryptor.js'
import type {
  ConnectionKey,
  ConnectionSnapshot,
  ConnectionStore,
  CredentialOperation,
  CredentialOperationCommand,
  CredentialOperationCommandInput,
  MutationRequest,
  StoreCommandResult,
} from './contracts/store.js'
import { digestStoreInput } from './contracts/store.js'
import {
  AuthorizationRequired,
  ConflictCause,
  EncryptionFailureCause,
  type CredentialFailure,
  InterventionRequired,
  TemporarilyUnavailable,
  ProviderFailureCause,
  ProviderOutcomeUnknownCause,
  ProviderRejectedCause,
  StorageFailureCause,
  type InterventionCause,
  type OperationalCause,
} from './failures.js'
import { randomRequestId } from '../internal/ids.js'
import {
  credentialOperationOwnershipLeaseMilliseconds,
  credentialOperationRecoveryMilliseconds,
  credentialOperationTransferLimit,
  waitForConnectionRevision,
} from '../internal/clock.js'

export type RenewableCredentialOutcome =
  | {
      readonly _tag: 'Acquired'
      readonly credentials: {
        readonly protectedPayload: import('effect').Redacted.Redacted<string>
        readonly credentialExpiresAt: number | null
      }
    }
  | { readonly _tag: 'ProviderRejected' }
  | { readonly _tag: 'ProviderFailure'; readonly recovery?: 'NotDispatched' }
  | { readonly _tag: 'ProviderOutcomeUnknown' }

function failureForCause(cause: OperationalCause): CredentialFailure {
  switch (cause._tag) {
    case 'ProviderRejected':
      return new AuthorizationRequired()
    case 'EncryptionFailure':
    case 'Conflict':
      return new InterventionRequired({ cause })
    case 'ProviderFailure':
    case 'StorageFailure':
      return new TemporarilyUnavailable({ cause })
  }
}
function interventionRequired(cause: InterventionCause): InterventionRequired {
  return new InterventionRequired({ cause })
}
function interventionCause(
  reason:
    | 'ProviderOutcomeUnknown'
    | 'KnownResponseNotPersisted'
    | 'DispatchOwnerExpired'
    | 'RecoveryLimitExceeded',
): InterventionCause {
  switch (reason) {
    case 'ProviderOutcomeUnknown':
    case 'DispatchOwnerExpired':
      return new ProviderOutcomeUnknownCause()
    case 'KnownResponseNotPersisted':
      return new EncryptionFailureCause()
    case 'RecoveryLimitExceeded':
      return new ConflictCause()
  }
}
function encryptionContext(key: ConnectionKey, generation: number): EncryptionContext {
  return { ...key, generation, purpose: 'credentials' }
}
function credentialRequest<Command extends CredentialOperationCommandInput>(
  input: Command,
): Effect.Effect<Command & { readonly request: MutationRequest }, CredentialFailure> {
  return Effect.tryPromise({
    try: async () => ({
      ...input,
      request: { requestId: randomRequestId(), inputDigest: await digestStoreInput(input) },
    }),
    catch: () => failureForCause(new StorageFailureCause()),
  })
}
function credentialIdentifier(): Effect.Effect<string, CredentialFailure> {
  return Effect.try({
    try: randomRequestId,
    catch: () => failureForCause(new StorageFailureCause()),
  })
}

export interface RenewableCredentialWorkflow<Credentials, Requirements> {
  readonly credentials: (
    key: ConnectionKey,
    waitUntil: number,
  ) => Effect.Effect<Credentials, CredentialFailure, Requirements>
}

/** Internal renewable-operation engine shared by OAuth refresh and client credential acquisition. */
export function makeRenewableCredentialWorkflow<
  Credentials,
  StoreError,
  ProviderRequirements,
  StoreRequirements,
  InspectionError,
  InspectionRequirements,
>(options: {
  readonly store: ConnectionStore<
    StoreError,
    StoreRequirements,
    InspectionError,
    InspectionRequirements
  >
  readonly operationKind: 'refresh' | 'client-credentials-acquisition'
  readonly isLocallyUsable: (snapshot: ConnectionSnapshot, now: number) => boolean
  readonly projectCredentials: (
    protectedPayload: import('effect').Redacted.Redacted<string>,
    snapshot: ConnectionSnapshot,
  ) => Effect.Effect<Credentials, unknown, ProviderRequirements>
  readonly acquireCredentials: (input: {
    readonly protectedPayload: import('effect').Redacted.Redacted<string>
    readonly now: number
  }) => Effect.Effect<RenewableCredentialOutcome, never, ProviderRequirements>
}): RenewableCredentialWorkflow<Credentials, ProviderRequirements | StoreRequirements> {
  type WorkflowRequirements = ProviderRequirements | StoreRequirements
  const readCredentialConnection = (
    key: ConnectionKey,
  ): Effect.Effect<ConnectionSnapshot | null, CredentialFailure, StoreRequirements> =>
    options.store
      .readConnection(key)
      .pipe(Effect.mapError(() => failureForCause(new StorageFailureCause())))

  const executeCredentialOperation = (
    command: CredentialOperationCommand,
  ): Effect.Effect<StoreCommandResult, CredentialFailure, StoreRequirements> =>
    options.store.executeCredentialOperation(command).pipe(
      Effect.retry({ times: 2 }),
      Effect.mapError(() => failureForCause(new StorageFailureCause())),
    )

  const projectCredentialSnapshot = (
    key: ConnectionKey,
    snapshot: ConnectionSnapshot,
  ): Effect.Effect<Credentials, CredentialFailure, WorkflowRequirements> =>
    options.store
      .unprotect(snapshot.credentialEnvelope, encryptionContext(key, snapshot.generation))
      .pipe(
        Effect.mapError(() => failureForCause(new EncryptionFailureCause())),
        Effect.flatMap((protectedPayload) =>
          options
            .projectCredentials(protectedPayload, snapshot)
            .pipe(Effect.mapError(() => failureForCause(new ProviderFailureCause()))),
        ),
      )

  const markIntervention = (
    key: ConnectionKey,
    operation: CredentialOperation,
    expectedRevision: number,
    markedAt: number,
    reason:
      | 'ProviderOutcomeUnknown'
      | 'KnownResponseNotPersisted'
      | 'DispatchOwnerExpired'
      | 'RecoveryLimitExceeded',
    ownershipFence: string | null,
  ): Effect.Effect<void, CredentialFailure, StoreRequirements> =>
    Effect.gen(function* () {
      const command = yield* credentialRequest({
        _tag: 'MarkCredentialOperationIntervention' as const,
        key,
        expectedGeneration: operation.generation,
        expectedRevision,
        operationId: operation.operationId,
        ownershipFence,
        markedAt,
        reason,
      })
      const result = yield* executeCredentialOperation(command)
      if (result._tag !== 'CredentialOperationInterventionMarked') {
        return yield* Effect.fail(failureForCause(new ConflictCause()))
      }
    })

  const recordKnownFailure = (
    key: ConnectionKey,
    operation: CredentialOperation,
    expectedRevision: number,
    ownershipFence: string,
    failedAt: number,
    reason: 'ProviderRejected' | 'ProviderFailure',
    recovery?: 'NotDispatched',
  ): Effect.Effect<void, CredentialFailure, StoreRequirements> =>
    Effect.gen(function* () {
      const command = yield* credentialRequest({
        _tag: 'RecordCredentialOperationFailure' as const,
        key,
        expectedGeneration: operation.generation,
        expectedRevision,
        operationId: operation.operationId,
        ownershipFence,
        failedAt,
        reason,
        ...(recovery === undefined ? {} : { recovery }),
      })
      const result = yield* executeCredentialOperation(command)
      if (result._tag !== 'CredentialOperationFailed') {
        return yield* Effect.fail(failureForCause(new ConflictCause()))
      }
    })

  const retrieveCredentials = (
    key: ConnectionKey,
    waitUntil: number,
  ): Effect.Effect<Credentials, CredentialFailure, WorkflowRequirements> =>
    Effect.gen(function* () {
      const snapshot = yield* readCredentialConnection(key)
      if (snapshot === null) return yield* Effect.fail(new AuthorizationRequired())

      const now = yield* Clock.currentTimeMillis
      const operation = snapshot.credentialOperation ?? null
      if (snapshot.authorization._tag === 'NotAuthorized') {
        if (operation?.kind === 'self-client-exchange') {
          if (operation.phase._tag === 'KnownFailure') {
            return yield* Effect.fail(
              failureForCause(
                operation.phase.reason === 'ProviderRejected'
                  ? new ProviderRejectedCause()
                  : new ProviderFailureCause(),
              ),
            )
          }
          if (operation.phase._tag === 'InterventionRequired') {
            return yield* Effect.fail(
              interventionRequired(interventionCause(operation.phase.reason)),
            )
          }
          if (operation.phase._tag === 'DispatchPossible') {
            if (operation.phase.leaseExpiresAt <= now) {
              yield* markIntervention(
                key,
                operation,
                snapshot.revision,
                now,
                'DispatchOwnerExpired',
                null,
              )
              return yield* Effect.fail(interventionRequired(new ProviderOutcomeUnknownCause()))
            }
            return yield* Effect.fail(new TemporarilyUnavailable({}))
          }
          if (operation.phase.leaseExpiresAt > now) {
            return yield* Effect.fail(new TemporarilyUnavailable({}))
          }
        }
        return yield* Effect.fail(new AuthorizationRequired())
      }
      if (
        operation?.kind === 'self-client-exchange' &&
        operation.phase._tag === 'OwnedBeforeDispatch' &&
        options.isLocallyUsable(snapshot, now)
      ) {
        return yield* projectCredentialSnapshot(key, snapshot)
      }
      if (operation === null && options.isLocallyUsable(snapshot, now)) {
        return yield* projectCredentialSnapshot(key, snapshot)
      }

      if (
        operation?.phase._tag === 'KnownFailure' &&
        !(
          operation.phase.reason === 'ProviderFailure' &&
          operation.phase.recovery === 'NotDispatched'
        )
      ) {
        return yield* Effect.fail(
          failureForCause(
            operation.phase.reason === 'ProviderRejected'
              ? new ProviderRejectedCause()
              : new ProviderFailureCause(),
          ),
        )
      }
      if (operation?.phase._tag === 'InterventionRequired') {
        return yield* Effect.fail(interventionRequired(interventionCause(operation.phase.reason)))
      }

      if (operation?.phase._tag === 'DispatchPossible') {
        if (operation.phase.leaseExpiresAt <= now) {
          yield* markIntervention(
            key,
            operation,
            snapshot.revision,
            now,
            'DispatchOwnerExpired',
            null,
          )
          return yield* Effect.fail(interventionRequired(new ProviderOutcomeUnknownCause()))
        }
        if (now >= waitUntil) {
          return yield* Effect.fail(new TemporarilyUnavailable({}))
        }
        const changed = yield* waitForConnectionRevision({
          observedRevision: snapshot.revision,
          waitUntil,
          read: () => readCredentialConnection(key),
        })
        if (changed === null) {
          return yield* Effect.fail(new TemporarilyUnavailable({}))
        }
        return yield* retrieveCredentials(key, waitUntil)
      }

      if (operation?.phase._tag === 'OwnedBeforeDispatch' && operation.phase.leaseExpiresAt > now) {
        if (now >= waitUntil) {
          return yield* Effect.fail(new TemporarilyUnavailable({}))
        }
        const changed = yield* waitForConnectionRevision({
          observedRevision: snapshot.revision,
          waitUntil,
          read: () => readCredentialConnection(key),
        })
        if (changed === null) {
          return yield* Effect.fail(new TemporarilyUnavailable({}))
        }
        return yield* retrieveCredentials(key, waitUntil)
      }

      if (
        operation?.phase._tag === 'OwnedBeforeDispatch' &&
        (operation.recoveryDeadline <= now || operation.transferCount >= operation.transferLimit)
      ) {
        yield* markIntervention(
          key,
          operation,
          snapshot.revision,
          now,
          'RecoveryLimitExceeded',
          null,
        )
        return yield* Effect.fail(interventionRequired(new ConflictCause()))
      }

      const operationId = yield* credentialIdentifier()
      const ownershipFence = yield* credentialIdentifier()
      const acquisition = yield* credentialRequest({
        _tag: 'AcquireCredentialOperation' as const,
        key,
        expectedGeneration: snapshot.generation,
        expectedRevision: snapshot.revision,
        acquiredAt: now,
        ownershipFence,
        leaseExpiresAt: now + credentialOperationOwnershipLeaseMilliseconds,
        proposal: {
          operationId,
          kind: options.operationKind,
          startedAt: now,
          recoveryDeadline: now + credentialOperationRecoveryMilliseconds,
          transferLimit: credentialOperationTransferLimit,
        },
      })
      const acquired = yield* executeCredentialOperation(acquisition)
      if (acquired._tag !== 'CredentialOperationAcquired') {
        if (now >= waitUntil) {
          return yield* Effect.fail(new TemporarilyUnavailable({}))
        }
        return yield* retrieveCredentials(key, waitUntil)
      }
      if (acquired.operation.phase._tag !== 'OwnedBeforeDispatch') {
        return yield* Effect.fail(failureForCause(new ConflictCause()))
      }

      const protectedPayload = yield* options.store
        .unprotect(snapshot.credentialEnvelope, encryptionContext(key, snapshot.generation))
        .pipe(Effect.mapError(() => failureForCause(new EncryptionFailureCause())))
      const reservedAt = yield* Clock.currentTimeMillis
      const reservation = yield* credentialRequest({
        _tag: 'ReserveCredentialOperationDispatch' as const,
        key,
        expectedGeneration: acquired.generation,
        expectedRevision: acquired.revision,
        operationId: acquired.operation.operationId,
        ownershipFence: acquired.operation.phase.ownershipFence,
        reservedAt,
      })
      const reserved = yield* executeCredentialOperation(reservation)
      if (reserved._tag !== 'CredentialOperationDispatchReserved') {
        return yield* Effect.fail(failureForCause(new ConflictCause()))
      }

      const refreshedAt = yield* Clock.currentTimeMillis
      const refresh = yield* options
        .acquireCredentials({
          protectedPayload,
          now: refreshedAt,
        })
        .pipe(Effect.catchDefect(() => Effect.succeed({ _tag: 'ProviderOutcomeUnknown' as const })))
      if (refresh._tag === 'ProviderOutcomeUnknown') {
        yield* markIntervention(
          key,
          acquired.operation,
          reserved.revision,
          yield* Clock.currentTimeMillis,
          'ProviderOutcomeUnknown',
          acquired.operation.phase.ownershipFence,
        )
        return yield* Effect.fail(interventionRequired(new ProviderOutcomeUnknownCause()))
      }
      if (refresh._tag === 'ProviderRejected' || refresh._tag === 'ProviderFailure') {
        yield* recordKnownFailure(
          key,
          acquired.operation,
          reserved.revision,
          acquired.operation.phase.ownershipFence,
          yield* Clock.currentTimeMillis,
          refresh._tag,
          refresh._tag === 'ProviderFailure' ? refresh.recovery : undefined,
        )
        return yield* Effect.fail(
          failureForCause(
            refresh._tag === 'ProviderRejected'
              ? new ProviderRejectedCause()
              : new ProviderFailureCause(),
          ),
        )
      }

      const protectedResult = yield* Effect.result(
        options.store.protect(
          refresh.credentials.protectedPayload,
          encryptionContext(key, acquired.generation),
        ),
      )
      if (Result.isFailure(protectedResult)) {
        yield* markIntervention(
          key,
          acquired.operation,
          reserved.revision,
          yield* Clock.currentTimeMillis,
          'KnownResponseNotPersisted',
          acquired.operation.phase.ownershipFence,
        )
        return yield* Effect.fail(failureForCause(new EncryptionFailureCause()))
      }

      const completionInput = {
        _tag: 'CompleteCredentialOperation' as const,
        key,
        expectedGeneration: acquired.generation,
        expectedRevision: reserved.revision,
        operationId: acquired.operation.operationId,
        ownershipFence: acquired.operation.phase.ownershipFence,
        credentialEnvelope: protectedResult.success,
        credentialExpiresAt: refresh.credentials.credentialExpiresAt,
        credentialAcquiredAt: refreshedAt,
        completedAt: yield* Clock.currentTimeMillis,
      }
      const completion = yield* credentialRequest(completionInput)
      const completed = yield* executeCredentialOperation(completion)
      if (completed._tag !== 'CredentialOperationCompleted') {
        return yield* Effect.fail(failureForCause(new ConflictCause()))
      }

      const confirmed = yield* readCredentialConnection(key)
      if (
        confirmed === null ||
        confirmed.authorization._tag !== 'Authorized' ||
        confirmed.generation !== completed.generation ||
        confirmed.revision !== completed.revision ||
        (confirmed.credentialOperation ?? null) !== null
      ) {
        return yield* Effect.fail(failureForCause(new ConflictCause()))
      }
      const confirmedAt = yield* Clock.currentTimeMillis
      if (!options.isLocallyUsable(confirmed, confirmedAt)) {
        return yield* Effect.fail(failureForCause(new ProviderFailureCause()))
      }
      return yield* projectCredentialSnapshot(key, confirmed)
    })

  return { credentials: retrieveCredentials }
}
