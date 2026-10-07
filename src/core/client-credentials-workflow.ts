import { makeLocalLifecycle } from './local-lifecycle.js'
import { Clock, Effect } from 'effect'
import type { EncryptionContext } from './contracts/encryptor.js'
import type { ClientCredentialsProviderDefinition } from './contracts/provider.js'
import type {
  ConnectionKey,
  ConnectionStore,
  CredentialOperationCommandInput,
  MutationRequest,
} from './contracts/store.js'
import { digestStoreInput } from './contracts/store.js'
import {
  CredentialConfigurationFailure,
  type CredentialFailure,
  InspectionFailure,
  RemovalFailure,
} from './failures.js'
import type {
  ConnectionIdentity,
  ConnectionInspection,
  CredentialUse,
  SetClientCredentialsInput,
} from './model.js'
import { credentialIsLocallyUsable } from './model.js'
import { randomRequestId } from '../internal/ids.js'
import { makeRenewableCredentialWorkflow } from './renewable-credential-workflow.js'
import { credentialFollowerWaitMilliseconds } from '../internal/clock.js'
import { reportCredentialRejected } from './credential-rejection.js'

function key(identity: ConnectionIdentity): ConnectionKey {
  return {
    namespace: identity.namespace,
    providerId: identity.providerId,
    connectionId: identity.connectionId,
  }
}
function context(key: ConnectionKey, generation: number): EncryptionContext {
  return { ...key, generation, purpose: 'credentials' }
}
function configurationFailure(reason: CredentialConfigurationFailure['reason']) {
  return new CredentialConfigurationFailure({ reason })
}
function request<Command extends CredentialOperationCommandInput, Error>(
  input: Command,
  failure: Error,
): Effect.Effect<Command & { readonly request: MutationRequest }, Error> {
  return Effect.tryPromise({
    try: async () => ({
      ...input,
      request: { requestId: randomRequestId(), inputDigest: await digestStoreInput(input) },
    }),
    catch: () => failure,
  })
}

export interface ClientCredentialsWorkflow<
  Source,
  Credentials,
  Requirements,
  InspectionRequirements = Requirements,
  RemovalRequirements = Requirements,
> {
  readonly setClientCredentials: (
    identity: ConnectionIdentity,
    input: SetClientCredentialsInput<Source>,
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

export function makeClientCredentialsWorkflow<
  Source,
  Credentials,
  StoreError,
  ProviderRequirements,
  StoreRequirements,
  InspectionError,
  InspectionRequirements,
>(options: {
  readonly provider: ClientCredentialsProviderDefinition<Source, Credentials, ProviderRequirements>
  readonly store: ConnectionStore<
    StoreError,
    StoreRequirements,
    InspectionError,
    InspectionRequirements
  >
}): ClientCredentialsWorkflow<
  Source,
  Credentials,
  ProviderRequirements | StoreRequirements,
  InspectionRequirements,
  StoreRequirements
> {
  const renewableCredentials = makeRenewableCredentialWorkflow({
    store: options.store,
    operationKind: 'client-credentials-acquisition',
    isLocallyUsable: (snapshot, now) => {
      if (
        snapshot.authorization._tag !== 'Authorized' ||
        snapshot.authorization.credentialAcquiredAt == null
      )
        return false
      return credentialIsLocallyUsable(snapshot.authorization.credentialExpiresAt, now)
    },
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
    acquireCredentials: options.provider.acquireCredentials,
  })

  return {
    ...makeLocalLifecycle(options.store),

    setClientCredentials: (identity, input) =>
      Effect.gen(function* () {
        const connectionKey = key(identity)
        const current = yield* options.store
          .readConnection(connectionKey)
          .pipe(Effect.mapError(() => configurationFailure('StorageFailure')))
        if (
          !(
            (input.intent === 'enroll' &&
              (current === null || current.authorization._tag === 'NotAuthorized')) ||
            (input.intent === 'replace' && current?.authorization._tag === 'Authorized')
          )
        )
          return yield* Effect.fail(configurationFailure('Conflict'))
        const prepared = yield* options.provider.prepareClientCredentials(input.credentials).pipe(
          Effect.mapError(() => configurationFailure('InvalidCredentials')),
          Effect.catchDefect(() => Effect.fail(configurationFailure('InvalidCredentials'))),
        )
        const generation =
          input.intent === 'replace' ? (current?.generation ?? 0) + 1 : (current?.generation ?? 0)
        const envelope = yield* options.store
          .protect(prepared.protectedPayload, context(connectionKey, generation))
          .pipe(Effect.mapError(() => configurationFailure('EncryptionFailure')))
        const command = yield* request(
          {
            _tag: 'SaveCredential' as const,
            key: connectionKey,
            expectedGeneration: current?.generation ?? 0,
            expectedRevision: current?.revision ?? 0,
            intent: input.intent,
            credentialEnvelope: envelope,
            credentialExpiresAt: null,
            credentialAcquiredAt: null,
          },
          configurationFailure('StorageFailure'),
        )
        const saved = yield* options.store
          .executeCredentialOperation(command)
          .pipe(Effect.mapError(() => configurationFailure('StorageFailure')))
        if (saved._tag !== 'CredentialSaved')
          return yield* Effect.fail(configurationFailure('Conflict'))
      }),
    credentials: (identity) =>
      Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis
        return yield* renewableCredentials.credentials(
          key(identity),
          now + credentialFollowerWaitMilliseconds,
        )
      }),
  }
}
