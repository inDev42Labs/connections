import { Clock, Effect, Result } from 'effect'
import type { SelfClientProviderDefinition } from './contracts/provider.js'
import type {
  ConnectionKey,
  ConnectionStore,
  CredentialOperation,
  CredentialOperationCommand,
  CredentialOperationCommandInput,
  MutationRequest,
  SelfClientExchangeAdmitted,
  SelfClientExchangeCompleted,
} from './contracts/store.js'
import { digestStoreInput } from './contracts/store.js'
import { AuthorizationFailure } from './failures.js'
import type { SelfClientEnrollmentInput, ConnectionIdentity } from './model.js'
import { makeOAuthCredentialWorkflow } from './workflow.js'
import {
  credentialOperationOwnershipLeaseMilliseconds,
  credentialOperationRecoveryMilliseconds,
  credentialOperationTransferLimit,
} from '../internal/clock.js'
import { randomRequestId } from '../internal/ids.js'
import type { OAuthCredentialWorkflow } from './workflow.js'

function connectionKey(identity: ConnectionIdentity): ConnectionKey {
  return {
    namespace: identity.namespace,
    providerId: identity.providerId,
    connectionId: identity.connectionId,
  }
}

function enrollmentRequest<Command extends CredentialOperationCommandInput>(
  input: Command,
): Effect.Effect<Command & { readonly request: MutationRequest }, AuthorizationFailure> {
  return Effect.tryPromise({
    try: async () => ({
      ...input,
      request: { requestId: randomRequestId(), inputDigest: await digestStoreInput(input) },
    }),
    catch: () => new AuthorizationFailure({ reason: 'StorageFailure' }),
  })
}

function identifier(): Effect.Effect<string, AuthorizationFailure> {
  return Effect.try({
    try: randomRequestId,
    catch: () => new AuthorizationFailure({ reason: 'ProviderFailure' }),
  })
}

export interface SelfClientWorkflow<
  Credentials,
  Requirements,
  InspectionRequirements = Requirements,
  RemovalRequirements = Requirements,
> extends OAuthCredentialWorkflow<
  Credentials,
  Requirements,
  InspectionRequirements,
  RemovalRequirements
> {
  readonly enrollCode: <AuthorizeError, AuthorizeRequirements>(
    identity: ConnectionIdentity,
    input: SelfClientEnrollmentInput<AuthorizeError, AuthorizeRequirements>,
  ) => Effect.Effect<
    void,
    AuthorizationFailure | AuthorizeError,
    Requirements | AuthorizeRequirements
  >
}

export function makeSelfClientWorkflow<
  Credentials,
  StoreError,
  ProviderRequirements,
  StoreRequirements,
  InspectionError,
  InspectionRequirements,
>(options: {
  readonly provider: SelfClientProviderDefinition<Credentials, ProviderRequirements>
  readonly store: ConnectionStore<
    StoreError,
    StoreRequirements,
    InspectionError,
    InspectionRequirements
  >
}): SelfClientWorkflow<
  Credentials,
  ProviderRequirements | StoreRequirements,
  InspectionRequirements,
  StoreRequirements
> {
  const credentialWorkflow = makeOAuthCredentialWorkflow({
    provider: options.provider,
    store: options.store,
  })

  const readConnection = (key: ConnectionKey) =>
    options.store
      .readConnection(key)
      .pipe(Effect.mapError(() => new AuthorizationFailure({ reason: 'StorageFailure' })))

  const execute = (command: CredentialOperationCommand) =>
    options.store.executeCredentialOperation(command).pipe(
      Effect.retry({ times: 2 }),
      Effect.mapError(() => new AuthorizationFailure({ reason: 'StorageFailure' })),
    )

  const markIntervention = (
    key: ConnectionKey,
    operation: CredentialOperation,
    expectedRevision: number,
    reason: 'ProviderOutcomeUnknown' | 'KnownResponseNotPersisted',
  ): Effect.Effect<void, AuthorizationFailure, StoreRequirements> =>
    Effect.gen(function* () {
      const input = yield* enrollmentRequest({
        _tag: 'MarkCredentialOperationIntervention' as const,
        key,
        expectedGeneration: operation.generation,
        expectedRevision,
        operationId: operation.operationId,
        ownershipFence:
          operation.phase._tag === 'OwnedBeforeDispatch' ||
          operation.phase._tag === 'DispatchPossible'
            ? operation.phase.ownershipFence
            : null,
        markedAt: yield* Clock.currentTimeMillis,
        reason,
      })
      const result = yield* execute(input)
      if (result._tag !== 'CredentialOperationInterventionMarked') {
        return yield* Effect.fail(new AuthorizationFailure({ reason: 'Conflict' }))
      }
    })

  const recordKnownFailure = (
    key: ConnectionKey,
    operation: CredentialOperation,
    expectedRevision: number,
    ownershipFence: string,
    reason: 'ProviderRejected' | 'ProviderFailure',
  ): Effect.Effect<void, AuthorizationFailure, StoreRequirements> =>
    Effect.gen(function* () {
      const input = yield* enrollmentRequest({
        _tag: 'RecordCredentialOperationFailure' as const,
        key,
        expectedGeneration: operation.generation,
        expectedRevision,
        operationId: operation.operationId,
        ownershipFence,
        failedAt: yield* Clock.currentTimeMillis,
        reason,
      })
      const result = yield* execute(input)
      if (result._tag !== 'CredentialOperationFailed') {
        return yield* Effect.fail(new AuthorizationFailure({ reason: 'Conflict' }))
      }
    })

  const confirmCompletion = (
    key: ConnectionKey,
    expectedGeneration: number,
    expectedRevision: number,
    intent: 'enroll' | 'replace',
  ): Effect.Effect<boolean, AuthorizationFailure, StoreRequirements> =>
    readConnection(key).pipe(
      Effect.map((current) => {
        const expectedSavedGeneration =
          intent === 'replace' ? expectedGeneration + 1 : expectedGeneration
        return (
          current !== null &&
          current.authorization._tag === 'Authorized' &&
          current.generation === expectedSavedGeneration &&
          current.revision === expectedRevision &&
          current.credentialOperation === null
        )
      }),
    )

  return {
    ...credentialWorkflow,
    enrollCode: (identity, input) =>
      Effect.gen(function* () {
        const key = connectionKey(identity)
        yield* input.authorize()
        const current = yield* readConnection(key)
        const intentMatchesCurrent =
          (input.intent === 'enroll' &&
            (current === null || current.authorization._tag === 'NotAuthorized')) ||
          (input.intent === 'replace' && current?.authorization._tag === 'Authorized')
        if (!intentMatchesCurrent) {
          return yield* Effect.fail(new AuthorizationFailure({ reason: 'Conflict' }))
        }

        const acquiredAt = yield* Clock.currentTimeMillis
        const operationId = yield* identifier()
        const ownershipFence = yield* identifier()
        const admissionInput = yield* enrollmentRequest({
          _tag: 'AdmitSelfClientExchange' as const,
          key,
          expectedGeneration: current?.generation ?? 0,
          expectedRevision: current?.revision ?? 0,
          intent: input.intent,
          acquiredAt,
          ownershipFence,
          leaseExpiresAt: acquiredAt + credentialOperationOwnershipLeaseMilliseconds,
          proposal: {
            operationId,
            startedAt: acquiredAt,
            recoveryDeadline: acquiredAt + credentialOperationRecoveryMilliseconds,
            transferLimit: credentialOperationTransferLimit,
          },
        })
        const admission = yield* execute(admissionInput)
        if (admission._tag !== 'SelfClientExchangeAdmitted') {
          return yield* Effect.fail(new AuthorizationFailure({ reason: 'Conflict' }))
        }
        const admitted: SelfClientExchangeAdmitted = admission
        if (admitted.operation.phase._tag !== 'OwnedBeforeDispatch') {
          return yield* Effect.fail(new AuthorizationFailure({ reason: 'Conflict' }))
        }

        const reservedAt = yield* Clock.currentTimeMillis
        const reservationInput = yield* enrollmentRequest({
          _tag: 'ReserveCredentialOperationDispatch' as const,
          key,
          expectedGeneration: admitted.generation,
          expectedRevision: admitted.revision,
          operationId: admitted.operation.operationId,
          ownershipFence: admitted.operation.phase.ownershipFence,
          reservedAt,
        })
        const reservation = yield* execute(reservationInput)
        if (reservation._tag !== 'CredentialOperationDispatchReserved') {
          return yield* Effect.fail(new AuthorizationFailure({ reason: 'Conflict' }))
        }

        const exchangeResult = yield* Effect.result(
          options.provider
            .exchangeSelfClientCode({
              code: input.code,
              now: yield* Clock.currentTimeMillis,
            })
            .pipe(Effect.catchDefect(() => Effect.fail({ reason: 'TransportFailure' as const }))),
        )
        if (Result.isFailure(exchangeResult)) {
          const reason = exchangeResult.failure.reason
          if (reason === 'TransportFailure' || reason === 'MalformedResponse') {
            yield* markIntervention(
              key,
              admitted.operation,
              reservation.revision,
              'ProviderOutcomeUnknown',
            )
            return yield* Effect.fail(new AuthorizationFailure({ reason: 'InterventionRequired' }))
          }

          const knownFailure =
            reason === 'ProviderRejected' ? 'ProviderRejected' : 'ProviderFailure'
          yield* recordKnownFailure(
            key,
            admitted.operation,
            reservation.revision,
            admitted.operation.phase.ownershipFence,
            knownFailure,
          )
          return yield* Effect.fail(new AuthorizationFailure({ reason: knownFailure }))
        }

        const exchanged = exchangeResult.success
        const targetGeneration =
          input.intent === 'replace' ? admitted.generation + 1 : admitted.generation
        const protectedResult = yield* Effect.result(
          options.store
            .protect(exchanged.protectedPayload, {
              ...key,
              generation: targetGeneration,
              purpose: 'credentials',
            })
            .pipe(Effect.catchDefect(() => Effect.fail(new Error('credential protection failed')))),
        )
        if (Result.isFailure(protectedResult)) {
          yield* markIntervention(
            key,
            admitted.operation,
            reservation.revision,
            'KnownResponseNotPersisted',
          )
          return yield* Effect.fail(new AuthorizationFailure({ reason: 'EncryptionFailure' }))
        }

        const completionInput = yield* enrollmentRequest({
          _tag: 'CompleteSelfClientExchange' as const,
          key,
          expectedGeneration: admitted.generation,
          expectedRevision: reservation.revision,
          operationId: admitted.operation.operationId,
          ownershipFence: admitted.operation.phase.ownershipFence,
          credentialEnvelope: protectedResult.success,
          credentialExpiresAt: exchanged.credentialExpiresAt,
          completedAt: yield* Clock.currentTimeMillis,
        })
        const completionResult = yield* Effect.result(execute(completionInput))
        if (
          Result.isSuccess(completionResult) &&
          completionResult.success._tag === 'SelfClientExchangeCompleted'
        ) {
          const completed: SelfClientExchangeCompleted = completionResult.success
          const confirmed = yield* confirmCompletion(
            key,
            admitted.generation,
            completed.revision,
            input.intent,
          )
          if (confirmed) return
          return yield* Effect.fail(new AuthorizationFailure({ reason: 'Conflict' }))
        }

        const completionRead = yield* Effect.result(
          confirmCompletion(key, admitted.generation, reservation.revision + 1, input.intent),
        )
        if (Result.isSuccess(completionRead) && completionRead.success) return

        yield* markIntervention(
          key,
          admitted.operation,
          reservation.revision,
          'KnownResponseNotPersisted',
        )
        return yield* Effect.fail(
          Result.isFailure(completionResult)
            ? completionResult.failure
            : new AuthorizationFailure({ reason: 'Conflict' }),
        )
      }),
  }
}
