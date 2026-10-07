import { makeLocalLifecycle } from './local-lifecycle.js'
import { Clock, Effect } from 'effect'
import type { EncryptionContext } from './contracts/encryptor.js'
import type { ApiKeyProviderDefinition } from './contracts/provider.js'
import type {
  ConnectionKey,
  ConnectionSnapshot,
  ConnectionStore,
  CredentialOperationCommand,
  CredentialOperationCommandInput,
  MutationRequest,
  StoreCommandResult,
} from './contracts/store.js'
import { digestStoreInput } from './contracts/store.js'
import {
  AuthorizationRequired,
  ConflictCause,
  CredentialConfigurationFailure,
  EncryptionFailureCause,
  type CredentialFailure,
  InspectionFailure,
  InterventionRequired,
  TemporarilyUnavailable,
  ProviderFailureCause,
  ProviderOutcomeUnknownCause,
  RemovalFailure,
  StorageFailureCause,
} from './failures.js'
import type {
  ConnectionIdentity,
  ConnectionInspection,
  CredentialUse,
  SetApiKeyInput,
} from './model.js'
import { credentialIsLocallyUsable } from './model.js'
import { reportCredentialRejected } from './credential-rejection.js'
import { randomRequestId } from '../internal/ids.js'

function connectionKey(identity: ConnectionIdentity): ConnectionKey {
  return {
    namespace: identity.namespace,
    providerId: identity.providerId,
    connectionId: identity.connectionId,
  }
}

function encryptionContext(key: ConnectionKey, generation: number): EncryptionContext {
  return { ...key, generation, purpose: 'credentials' }
}

function configurationFailure(
  reason: CredentialConfigurationFailure['reason'],
): CredentialConfigurationFailure {
  return new CredentialConfigurationFailure({ reason })
}

function configurationRequest<Command extends CredentialOperationCommandInput>(
  input: Command,
): Effect.Effect<Command & { readonly request: MutationRequest }, CredentialConfigurationFailure> {
  return Effect.tryPromise({
    try: async () => ({
      ...input,
      request: {
        requestId: randomRequestId(),
        inputDigest: await digestStoreInput(input),
      },
    }),
    catch: () => configurationFailure('StorageFailure'),
  })
}

export interface ApiKeyWorkflow<
  Credentials,
  Requirements,
  InspectionRequirements = Requirements,
  RemovalRequirements = Requirements,
> {
  readonly setApiKey: (
    identity: ConnectionIdentity,
    input: SetApiKeyInput,
  ) => Effect.Effect<void, CredentialConfigurationFailure, Requirements>
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

export function makeApiKeyWorkflow<
  Credentials,
  StoreError,
  ProviderRequirements,
  StoreRequirements,
  InspectionError,
  InspectionRequirements,
>(options: {
  readonly provider: ApiKeyProviderDefinition<Credentials, ProviderRequirements>
  readonly store: ConnectionStore<
    StoreError,
    StoreRequirements,
    InspectionError,
    InspectionRequirements
  >
}): ApiKeyWorkflow<
  Credentials,
  ProviderRequirements | StoreRequirements,
  InspectionRequirements,
  StoreRequirements
> {
  type WorkflowRequirements = ProviderRequirements | StoreRequirements

  const readConfigurationConnection = (
    key: ConnectionKey,
  ): Effect.Effect<ConnectionSnapshot | null, CredentialConfigurationFailure, StoreRequirements> =>
    options.store
      .readConnection(key)
      .pipe(Effect.mapError(() => configurationFailure('StorageFailure')))

  const executeConfiguration = (
    command: CredentialOperationCommand,
  ): Effect.Effect<StoreCommandResult, CredentialConfigurationFailure, StoreRequirements> =>
    options.store.executeCredentialOperation(command).pipe(
      Effect.retry({ times: 2 }),
      Effect.mapError(() => configurationFailure('StorageFailure')),
    )

  const readCredentialConnection = (
    key: ConnectionKey,
  ): Effect.Effect<ConnectionSnapshot | null, CredentialFailure, StoreRequirements> =>
    options.store
      .readConnection(key)
      .pipe(Effect.mapError(() => new TemporarilyUnavailable({ cause: new StorageFailureCause() })))

  const projectCredentialSnapshot = (
    key: ConnectionKey,
    snapshot: ConnectionSnapshot,
  ): Effect.Effect<
    CredentialUse<Credentials, WorkflowRequirements>,
    CredentialFailure,
    WorkflowRequirements
  > =>
    options.store
      .unprotect(snapshot.credentialEnvelope, encryptionContext(key, snapshot.generation))
      .pipe(
        Effect.mapError(() => new InterventionRequired({ cause: new EncryptionFailureCause() })),
        Effect.flatMap((protectedPayload) =>
          options.provider.projectCredentials(protectedPayload).pipe(
            Effect.map((credentials) => ({
              credentials,
              reportRejected: () =>
                reportCredentialRejected(
                  options.store,
                  key,
                  snapshot.generation,
                  snapshot.revision,
                ),
            })),
            Effect.mapError(
              () => new TemporarilyUnavailable({ cause: new ProviderFailureCause() }),
            ),
          ),
        ),
      )

  return {
    ...makeLocalLifecycle(options.store),

    setApiKey: (identity, input) =>
      Effect.gen(function* () {
        const key = connectionKey(identity)
        const current = yield* readConfigurationConnection(key)
        const intentMatchesCondition =
          (input.intent === 'enroll' &&
            (current === null || current.authorization._tag === 'NotAuthorized')) ||
          (input.intent === 'replace' && current?.authorization._tag === 'Authorized')
        if (!intentMatchesCondition) {
          return yield* Effect.fail(configurationFailure('Conflict'))
        }

        const prepared = yield* options.provider.prepareApiKey(input.apiKey).pipe(
          Effect.mapError(() => configurationFailure('InvalidApiKey')),
          Effect.catchDefect(() => Effect.fail(configurationFailure('InvalidApiKey'))),
        )
        const expectedGeneration = current?.generation ?? 0
        const expectedRevision = current?.revision ?? 0
        const targetGeneration =
          input.intent === 'replace' ? expectedGeneration + 1 : expectedGeneration
        const credentialEnvelope = yield* options.store
          .protect(prepared.protectedPayload, encryptionContext(key, targetGeneration))
          .pipe(Effect.mapError(() => configurationFailure('EncryptionFailure')))
        const command = yield* configurationRequest({
          _tag: 'SaveCredential' as const,
          key,
          expectedGeneration,
          expectedRevision,
          intent: input.intent,
          credentialEnvelope,
          credentialExpiresAt: prepared.credentialExpiresAt,
          credentialAcquiredAt: null,
        })
        const saved = yield* executeConfiguration(command)
        if (saved._tag !== 'CredentialSaved') {
          return yield* Effect.fail(configurationFailure('Conflict'))
        }

        const confirmed = yield* readConfigurationConnection(key)
        if (
          confirmed === null ||
          confirmed.authorization._tag !== 'Authorized' ||
          confirmed.generation !== saved.generation ||
          confirmed.revision !== saved.revision ||
          confirmed.credentialOperation !== null
        ) {
          return yield* Effect.fail(configurationFailure('Conflict'))
        }
      }),

    credentials: (identity) =>
      Effect.gen(function* () {
        const key = connectionKey(identity)
        const snapshot = yield* readCredentialConnection(key)
        if (snapshot === null || snapshot.authorization._tag === 'NotAuthorized') {
          return yield* Effect.fail(new AuthorizationRequired())
        }
        const operation = snapshot.credentialOperation
        if (operation === null) {
          const now = yield* Clock.currentTimeMillis
          if (!credentialIsLocallyUsable(snapshot.authorization.credentialExpiresAt, now))
            return yield* Effect.fail(new AuthorizationRequired())
          return yield* projectCredentialSnapshot(key, snapshot)
        }
        switch (operation.phase._tag) {
          case 'OwnedBeforeDispatch':
          case 'DispatchPossible':
            return yield* Effect.fail(new TemporarilyUnavailable({}))
          case 'KnownFailure':
            return yield* Effect.fail(
              operation.phase.reason === 'ProviderRejected'
                ? new AuthorizationRequired()
                : new TemporarilyUnavailable({ cause: new ProviderFailureCause() }),
            )
          case 'InterventionRequired':
            return yield* Effect.fail(
              new InterventionRequired({
                cause:
                  operation.phase.reason === 'RecoveryLimitExceeded'
                    ? new ConflictCause()
                    : new ProviderOutcomeUnknownCause(),
              }),
            )
        }
      }),
  }
}
