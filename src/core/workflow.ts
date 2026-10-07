import { makeLocalLifecycle } from './local-lifecycle.js'
import { Clock, Effect, Redacted, Result } from 'effect'
import type { EncryptionContext } from './contracts/encryptor.js'
import type { OAuthProviderDefinition } from './contracts/provider.js'
import type {
  AuthorizationAdmission,
  ConnectionKey,
  ConnectionStore,
  CredentialOperationCommand,
  CredentialOperationCommandInput,
  MutationRequest,
  StoreCommand,
} from './contracts/store.js'
import { digestStoreInput } from './contracts/store.js'
import {
  AuthorizationFailure,
  type CredentialFailure,
  InspectionFailure,
  RemovalFailure,
} from './failures.js'
import type {
  AuthorizationStart,
  AuthorizationStartInput,
  CompleteAuthorizationInput,
  ConnectionIdentity,
  ConnectionInspection,
  CredentialUse,
} from './model.js'
import { credentialIsLocallyUsable } from './model.js'
import { makeRenewableCredentialWorkflow } from './renewable-credential-workflow.js'
import { reportCredentialRejected } from './credential-rejection.js'
import {
  digestAuthorizationBinding,
  digestAuthorizationState,
  randomAuthorizationState,
  randomPkceVerifier,
  randomRequestId,
  s256PkceChallenge,
} from '../internal/ids.js'
import {
  credentialFollowerWaitMilliseconds,
  credentialOperationOwnershipLeaseMilliseconds,
  credentialOperationRecoveryMilliseconds,
  credentialOperationTransferLimit,
} from '../internal/clock.js'

const authorizationAttemptLifetime = 10 * 60 * 1000
const authorizationAdmissionLifetime = credentialOperationRecoveryMilliseconds

function connectionKey(identity: ConnectionIdentity): ConnectionKey {
  return {
    namespace: identity.namespace,
    providerId: identity.providerId,
    connectionId: identity.connectionId,
  }
}

function encryptionContext(
  key: ConnectionKey,
  generation: number,
  purpose: EncryptionContext['purpose'],
): EncryptionContext {
  return { ...key, generation, purpose }
}

function authorizationRequest(
  input: unknown,
): Effect.Effect<MutationRequest, AuthorizationFailure> {
  return Effect.tryPromise({
    try: async () => ({
      requestId: randomRequestId(),
      inputDigest: await digestStoreInput(input),
    }),
    catch: () => new AuthorizationFailure({ reason: 'StorageFailure' }),
  })
}

function identifier<Value>(make: () => Value): Effect.Effect<Value, AuthorizationFailure> {
  return Effect.try({
    try: make,
    catch: () => new AuthorizationFailure({ reason: 'ProviderFailure' }),
  })
}

export interface OAuthCredentialWorkflow<
  Credentials,
  Requirements,
  InspectionRequirements = Requirements,
  RemovalRequirements = Requirements,
> {
  readonly credentials: (
    identity: ConnectionIdentity,
  ) => Effect.Effect<CredentialUse<Credentials, Requirements>, CredentialFailure, Requirements>
  readonly inspect: (
    identity: ConnectionIdentity,
  ) => Effect.Effect<ConnectionInspection, InspectionFailure, InspectionRequirements>
  readonly remove: (
    identity: ConnectionIdentity,
  ) => Effect.Effect<void, RemovalFailure, RemovalRequirements>
}

export interface OAuthWorkflow<
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
  readonly startAuthorization: (
    identity: ConnectionIdentity,
    input: AuthorizationStartInput,
  ) => Effect.Effect<AuthorizationStart, AuthorizationFailure, Requirements>
  readonly completeAuthorization: <AuthorizeError, AuthorizeRequirements>(
    input: CompleteAuthorizationInput<AuthorizeError, AuthorizeRequirements>,
  ) => Effect.Effect<
    ConnectionIdentity,
    AuthorizationFailure | AuthorizeError,
    Requirements | AuthorizeRequirements
  >
}

export function makeOAuthCredentialWorkflow<
  Credentials,
  StoreError,
  ProviderRequirements,
  StoreRequirements,
  InspectionError,
  InspectionRequirements,
>(options: {
  readonly provider: Pick<
    OAuthProviderDefinition<Credentials, ProviderRequirements>,
    'refreshCredentials' | 'projectCredentials'
  >
  readonly store: ConnectionStore<
    StoreError,
    StoreRequirements,
    InspectionError,
    InspectionRequirements
  >
}): OAuthCredentialWorkflow<
  Credentials,
  ProviderRequirements | StoreRequirements,
  InspectionRequirements,
  StoreRequirements
> {
  const renewableCredentials = makeRenewableCredentialWorkflow({
    store: options.store,
    operationKind: 'refresh',
    isLocallyUsable: (snapshot, now) =>
      snapshot.authorization._tag === 'Authorized' &&
      credentialIsLocallyUsable(snapshot.authorization.credentialExpiresAt, now),
    projectCredentials: (protectedPayload, snapshot) =>
      options.provider.projectCredentials(protectedPayload).pipe(
        Effect.map((credentials) => ({
          credentials,
          reportRejected: () =>
            reportCredentialRejected(
              options.store,
              snapshot.key,
              snapshot.generation,
              snapshot.revision,
            ),
        })),
      ),
    acquireCredentials: (input) =>
      options.provider
        .refreshCredentials(input)
        .pipe(
          Effect.map((outcome) =>
            outcome._tag === 'Refreshed'
              ? { _tag: 'Acquired' as const, credentials: outcome.credentials }
              : outcome,
          ),
        ),
  })

  return {
    ...makeLocalLifecycle(options.store),

    credentials: (identity) =>
      Effect.gen(function* () {
        const startedAt = yield* Clock.currentTimeMillis
        return yield* renewableCredentials.credentials(
          connectionKey(identity),
          startedAt + credentialFollowerWaitMilliseconds,
        )
      }),
  }
}

export function makeOAuthWorkflow<
  Credentials,
  StoreError,
  ProviderRequirements,
  StoreRequirements,
  InspectionError,
  InspectionRequirements,
>(options: {
  readonly namespace: string
  readonly provider: OAuthProviderDefinition<Credentials, ProviderRequirements>
  readonly store: ConnectionStore<
    StoreError,
    StoreRequirements,
    InspectionError,
    InspectionRequirements
  >
}): OAuthWorkflow<
  Credentials,
  ProviderRequirements | StoreRequirements,
  InspectionRequirements,
  StoreRequirements
> {
  const execute = (command: StoreCommand) =>
    options.store
      .execute(command)
      .pipe(Effect.mapError(() => new AuthorizationFailure({ reason: 'StorageFailure' })))

  const readAuthorizationConnection = (key: ConnectionKey) =>
    options.store
      .readConnection(key)
      .pipe(Effect.mapError(() => new AuthorizationFailure({ reason: 'StorageFailure' })))

  const executeAuthorizationOperation = (command: CredentialOperationCommand) =>
    options.store.executeCredentialOperation(command).pipe(
      Effect.retry({ times: 2 }),
      Effect.mapError(() => new AuthorizationFailure({ reason: 'StorageFailure' })),
    )

  const authorizationOperationRequest = <Command extends CredentialOperationCommandInput>(
    input: Command,
  ): Effect.Effect<Command & { readonly request: MutationRequest }, AuthorizationFailure> =>
    Effect.tryPromise({
      try: async () => ({
        ...input,
        request: {
          requestId: randomRequestId(),
          inputDigest: await digestStoreInput(input),
        },
      }),
      catch: () => new AuthorizationFailure({ reason: 'StorageFailure' }),
    })

  const credentialWorkflow = makeOAuthCredentialWorkflow({
    provider: options.provider,
    store: options.store,
  })

  return {
    inspect: credentialWorkflow.inspect,
    remove: credentialWorkflow.remove,

    startAuthorization: (identity, input) =>
      Effect.gen(function* () {
        const key = connectionKey(identity)
        const current = yield* readAuthorizationConnection(key)
        const intentMatchesCondition =
          (input.intent === 'enroll' &&
            (current === null || current.authorization._tag === 'NotAuthorized')) ||
          (input.intent === 'replace' && current?.authorization._tag === 'Authorized')
        if (!intentMatchesCondition) {
          return yield* Effect.fail(new AuthorizationFailure({ reason: 'Conflict' }))
        }
        const generation = current?.generation ?? 0
        const now = yield* Clock.currentTimeMillis
        const state = yield* identifier(randomAuthorizationState)
        const verifier = yield* identifier(randomPkceVerifier)
        const [stateDigest, bindingDigest, codeChallenge] = yield* Effect.tryPromise({
          try: () =>
            Promise.all([
              digestAuthorizationState(state),
              digestAuthorizationBinding(input.binding),
              s256PkceChallenge(verifier),
            ]),
          catch: () => new AuthorizationFailure({ reason: 'ProviderFailure' }),
        })
        const url = yield* options.provider
          .authorizationUrl({ state, codeChallenge })
          .pipe(Effect.mapError(() => new AuthorizationFailure({ reason: 'ProviderFailure' })))
        const pkceVerifierEnvelope = yield* options.store
          .protect(
            Redacted.make(verifier),
            encryptionContext(key, generation, 'authorization-pkce'),
          )
          .pipe(Effect.mapError(() => new AuthorizationFailure({ reason: 'EncryptionFailure' })))
        const attempt = {
          schemaVersion: 1 as const,
          stateDigest,
          key,
          generation,
          intent: input.intent,
          bindingDigest,
          pkceVerifierEnvelope,
          createdAt: now,
          expiresAt: now + authorizationAttemptLifetime,
        }
        const commandInput = {
          _tag: 'CreateAuthorizationAttempt' as const,
          attempt,
        }
        const request = yield* authorizationRequest(commandInput)
        const result = yield* execute({ ...commandInput, request })
        if (result._tag !== 'AuthorizationAttemptCreated') {
          return yield* Effect.fail(new AuthorizationFailure({ reason: 'Conflict' }))
        }
        return { url, expiresAt: attempt.expiresAt }
      }),

    completeAuthorization: (input) =>
      Effect.gen(function* () {
        const callback = yield* options.provider
          .parseAuthorizationCallback(input.callbackUrl)
          .pipe(Effect.mapError(() => new AuthorizationFailure({ reason: 'InvalidCallback' })))
        const lookupAt = yield* Clock.currentTimeMillis
        const [stateDigest, bindingDigest] = yield* Effect.tryPromise({
          try: () =>
            Promise.all([
              digestAuthorizationState(callback.state),
              digestAuthorizationBinding(input.binding),
            ]),
          catch: () => new AuthorizationFailure({ reason: 'InvalidAttempt' }),
        })
        const attempt = yield* options.store
          .readAuthorizationAttempt({
            namespace: options.namespace,
            stateDigest,
            bindingDigest,
            now: lookupAt,
          })
          .pipe(Effect.mapError(() => new AuthorizationFailure({ reason: 'StorageFailure' })))
        if (attempt === null || attempt.key.providerId !== options.provider.id) {
          return yield* Effect.fail(new AuthorizationFailure({ reason: 'InvalidAttempt' }))
        }

        yield* input.authorize({
          connectionId: attempt.key.connectionId,
          intent: attempt.intent,
        })

        if (callback._tag === 'AuthorizationDenied') {
          const closedAt = yield* Clock.currentTimeMillis
          const commandInput = {
            _tag: 'CloseAuthorizationAttempt' as const,
            stateDigest,
            key: attempt.key,
            expectedGeneration: attempt.generation,
            closedAt,
            reason: 'ProviderDenied' as const,
          }
          const request = yield* authorizationRequest(commandInput)
          const result = yield* execute({ ...commandInput, request })
          if (result._tag !== 'AuthorizationAttemptClosed') {
            return yield* Effect.fail(new AuthorizationFailure({ reason: 'Conflict' }))
          }
          return yield* Effect.fail(new AuthorizationFailure({ reason: 'ProviderDenied' }))
        }

        const codeVerifier = yield* options.store
          .unprotect(
            attempt.pkceVerifierEnvelope,
            encryptionContext(attempt.key, attempt.generation, 'authorization-pkce'),
          )
          .pipe(Effect.mapError(() => new AuthorizationFailure({ reason: 'EncryptionFailure' })))
        const admissionId = yield* identifier(randomRequestId)
        const operationId = yield* identifier(randomRequestId)
        const ownershipFence = yield* identifier(randomRequestId)
        const admittedAt = yield* Clock.currentTimeMillis
        const admission: AuthorizationAdmission = {
          stateDigest,
          key: attempt.key,
          intent: attempt.intent,
          generation: attempt.generation,
          admissionId,
          admittedAt,
          admissionExpiresAt: admittedAt + authorizationAdmissionLifetime,
        }
        const admissionInput = {
          _tag: 'AdmitAuthorizationAttempt' as const,
          admission,
          ownershipFence,
          leaseExpiresAt: admittedAt + credentialOperationOwnershipLeaseMilliseconds,
          operation: {
            operationId,
            kind: 'authorization-exchange' as const,
            startedAt: admittedAt,
            recoveryDeadline: admittedAt + credentialOperationRecoveryMilliseconds,
            transferLimit: credentialOperationTransferLimit,
          },
        }
        const admissionRequest = yield* authorizationRequest(admissionInput)
        const admitted = yield* execute({ ...admissionInput, request: admissionRequest }).pipe(
          Effect.retry({ times: 2 }),
        )
        if (admitted._tag !== 'AuthorizationAttemptAdmitted') {
          const current = yield* readAuthorizationConnection(attempt.key)
          if (
            current?.credentialOperation?.phase._tag === 'InterventionRequired' ||
            current?.credentialOperation?.phase._tag === 'KnownFailure'
          ) {
            return yield* Effect.fail(new AuthorizationFailure({ reason: 'InterventionRequired' }))
          }
          if (
            current?.credentialOperation?.phase._tag === 'OwnedBeforeDispatch' ||
            current?.credentialOperation?.phase._tag === 'DispatchPossible'
          ) {
            return yield* Effect.fail(new AuthorizationFailure({ reason: 'Pending' }))
          }
          return yield* Effect.fail(new AuthorizationFailure({ reason: 'InvalidAttempt' }))
        }
        if (admitted.operation.phase._tag !== 'OwnedBeforeDispatch') {
          return yield* Effect.fail(new AuthorizationFailure({ reason: 'Conflict' }))
        }

        const reservationInput = {
          _tag: 'ReserveCredentialOperationDispatch' as const,
          key: attempt.key,
          expectedGeneration: admitted.generation,
          expectedRevision: admitted.revision,
          operationId: admitted.operation.operationId,
          ownershipFence: admitted.operation.phase.ownershipFence,
          reservedAt: yield* Clock.currentTimeMillis,
        }
        const reservation = yield* authorizationOperationRequest(reservationInput)
        const reserved = yield* executeAuthorizationOperation(reservation)
        if (reserved._tag !== 'CredentialOperationDispatchReserved') {
          return yield* Effect.fail(new AuthorizationFailure({ reason: 'Conflict' }))
        }

        const exchangeResult = yield* Effect.result(
          options.provider.exchangeAuthorizationCode({
            code: callback.code,
            codeVerifier,
            now: admittedAt,
          }),
        )
        if (
          Result.isFailure(exchangeResult) &&
          exchangeResult.failure.reason === 'TransportFailure'
        ) {
          const intervention = yield* authorizationOperationRequest({
            _tag: 'MarkCredentialOperationIntervention' as const,
            key: attempt.key,
            expectedGeneration: admitted.generation,
            expectedRevision: reserved.revision,
            operationId: admitted.operation.operationId,
            ownershipFence: admitted.operation.phase.ownershipFence,
            markedAt: yield* Clock.currentTimeMillis,
            reason: 'ProviderOutcomeUnknown' as const,
          })
          const marked = yield* executeAuthorizationOperation(intervention)
          if (marked._tag !== 'CredentialOperationInterventionMarked') {
            return yield* Effect.fail(new AuthorizationFailure({ reason: 'Conflict' }))
          }
          return yield* Effect.fail(new AuthorizationFailure({ reason: 'InterventionRequired' }))
        }
        if (Result.isFailure(exchangeResult)) {
          const reason =
            exchangeResult.failure.reason === 'ProviderRejected'
              ? ('ProviderRejected' as const)
              : ('ProviderFailure' as const)
          const failure = yield* authorizationOperationRequest({
            _tag: 'RecordCredentialOperationFailure' as const,
            key: attempt.key,
            expectedGeneration: admitted.generation,
            expectedRevision: reserved.revision,
            operationId: admitted.operation.operationId,
            ownershipFence: admitted.operation.phase.ownershipFence,
            failedAt: yield* Clock.currentTimeMillis,
            reason,
          })
          const recorded = yield* executeAuthorizationOperation(failure)
          if (recorded._tag !== 'CredentialOperationFailed') {
            return yield* Effect.fail(new AuthorizationFailure({ reason: 'Conflict' }))
          }
          return yield* Effect.fail(new AuthorizationFailure({ reason }))
        }

        const exchanged = exchangeResult.success
        const targetGeneration =
          admission.intent === 'replace' ? admission.generation + 1 : admission.generation
        const protectedResult = yield* Effect.result(
          options.store.protect(
            exchanged.protectedPayload,
            encryptionContext(attempt.key, targetGeneration, 'credentials'),
          ),
        )
        if (Result.isFailure(protectedResult)) {
          const intervention = yield* authorizationOperationRequest({
            _tag: 'MarkCredentialOperationIntervention' as const,
            key: attempt.key,
            expectedGeneration: admitted.generation,
            expectedRevision: reserved.revision,
            operationId: admitted.operation.operationId,
            ownershipFence: admitted.operation.phase.ownershipFence,
            markedAt: yield* Clock.currentTimeMillis,
            reason: 'KnownResponseNotPersisted' as const,
          })
          yield* executeAuthorizationOperation(intervention)
          return yield* Effect.fail(new AuthorizationFailure({ reason: 'EncryptionFailure' }))
        }

        const completedAt = yield* Clock.currentTimeMillis
        const completionInput = {
          _tag: 'CompleteAuthorizationAttempt' as const,
          admission,
          expectedRevision: reserved.revision,
          operationId: admitted.operation.operationId,
          ownershipFence: admitted.operation.phase.ownershipFence,
          credentialEnvelope: protectedResult.success,
          credentialExpiresAt: exchanged.credentialExpiresAt,
          completedAt,
        }
        const completionRequest = yield* authorizationRequest(completionInput)
        const completionResult = yield* Effect.result(
          execute({ ...completionInput, request: completionRequest }),
        )
        const completed = Result.isSuccess(completionResult)
          ? completionResult.success
          : {
              _tag: 'AuthorizationCompleted' as const,
              generation: targetGeneration,
              revision: reserved.revision + 1,
            }
        if (completed._tag !== 'AuthorizationCompleted') {
          return yield* Effect.fail(new AuthorizationFailure({ reason: 'Conflict' }))
        }
        const confirmed = yield* readAuthorizationConnection(attempt.key)
        if (
          confirmed === null ||
          confirmed.authorization._tag !== 'Authorized' ||
          confirmed.generation !== completed.generation ||
          confirmed.revision !== completed.revision ||
          confirmed.credentialOperation !== null
        ) {
          return yield* Result.isFailure(completionResult)
            ? Effect.fail(completionResult.failure)
            : Effect.fail(new AuthorizationFailure({ reason: 'Conflict' }))
        }
        return {
          namespace: attempt.key.namespace,
          providerId: attempt.key.providerId,
          connectionId: attempt.key.connectionId,
        }
      }),

    credentials: credentialWorkflow.credentials,
  }
}
