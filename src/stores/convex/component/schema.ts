import { defineSchema, defineTable } from 'convex/server'
import { v } from 'convex/values'

export const componentSchemaVersion = 1 as const
export const componentSchemaVersionValidator = v.literal(componentSchemaVersion)

export const connectionKeyValidator = v.object({
  namespace: v.string(),
  providerId: v.string(),
  connectionId: v.string(),
})

export const credentialEnvelopeValidator = v.object({
  version: v.literal(1),
  algorithm: v.literal('AES-256-GCM'),
  keyId: v.string(),
  iv: v.string(),
  ciphertext: v.string(),
})

export const authorizationIntentValidator = v.union(v.literal('enroll'), v.literal('replace'))

export const authorizationValidator = v.union(
  v.object({ _tag: v.literal('NotAuthorized') }),
  v.object({
    _tag: v.literal('Authorized'),
    credentialExpiresAt: v.union(v.number(), v.null()),
    credentialAcquiredAt: v.optional(v.union(v.number(), v.null())),
  }),
)

export const authorizationAttemptValidator = v.object({
  schemaVersion: componentSchemaVersionValidator,
  stateDigest: v.string(),
  key: connectionKeyValidator,
  generation: v.number(),
  intent: authorizationIntentValidator,
  bindingDigest: v.string(),
  pkceVerifierEnvelope: credentialEnvelopeValidator,
  createdAt: v.number(),
  expiresAt: v.number(),
})

export const authorizationAdmissionValidator = v.object({
  stateDigest: v.string(),
  key: connectionKeyValidator,
  intent: authorizationIntentValidator,
  generation: v.number(),
  admissionId: v.string(),
  admittedAt: v.number(),
  admissionExpiresAt: v.number(),
})

export const authorizationAttemptStateValidator = v.union(
  v.object({ _tag: v.literal('Prepared') }),
  v.object({
    _tag: v.literal('Admitted'),
    admission: authorizationAdmissionValidator,
  }),
  v.object({
    _tag: v.literal('Closed'),
    reason: v.union(v.literal('ProviderDenied'), v.literal('Completed'), v.literal('Superseded')),
  }),
)

export const credentialOperationProposalValidator = v.object({
  operationId: v.string(),
  kind: v.union(
    v.literal('refresh'),
    v.literal('authorization-exchange'),
    v.literal('client-credentials-acquisition'),
  ),
  startedAt: v.number(),
  recoveryDeadline: v.number(),
  transferLimit: v.number(),
})

export const credentialFailureRecoveryValidator = v.union(
  v.literal('NotDispatched'),
  v.object({ _tag: v.literal('ReplaySafe'), retryUntil: v.number(), retryAt: v.number() }),
)

const credentialOperationFields = {
  schemaVersion: componentSchemaVersionValidator,
  operationId: v.string(),
  generation: v.number(),
  observedRevision: v.number(),
  startedAt: v.number(),
  recoveryDeadline: v.number(),
  transferCount: v.number(),
  transferLimit: v.number(),
  replayUntil: v.optional(v.number()),
  phase: v.union(
    v.object({
      _tag: v.literal('OwnedBeforeDispatch'),
      ownershipFence: v.string(),
      leaseExpiresAt: v.number(),
    }),
    v.object({
      _tag: v.literal('DispatchPossible'),
      ownershipFence: v.string(),
      leaseExpiresAt: v.number(),
      reservedAt: v.number(),
    }),
    v.object({
      _tag: v.literal('KnownFailure'),
      reason: v.union(v.literal('ProviderRejected'), v.literal('ProviderFailure')),
      failedAt: v.number(),
      recovery: v.optional(credentialFailureRecoveryValidator),
    }),
    v.object({
      _tag: v.literal('InterventionRequired'),
      reason: v.union(
        v.literal('ProviderOutcomeUnknown'),
        v.literal('KnownResponseNotPersisted'),
        v.literal('DispatchOwnerExpired'),
        v.literal('RecoveryLimitExceeded'),
      ),
      markedAt: v.number(),
    }),
  ),
}

const selfClientExchangeOperationValidator = v.object({
  ...credentialOperationFields,
  kind: v.literal('self-client-exchange'),
  intent: authorizationIntentValidator,
})

export const credentialOperationValidator = v.union(
  v.object({
    ...credentialOperationFields,
    kind: v.union(
      v.literal('refresh'),
      v.literal('authorization-exchange'),
      v.literal('client-credentials-acquisition'),
    ),
  }),
  selfClientExchangeOperationValidator,
)

export const connectionFields = {
  storageKey: v.string(),
  schemaVersion: componentSchemaVersionValidator,
  key: connectionKeyValidator,
  generation: v.number(),
  revision: v.number(),
  authorization: authorizationValidator,
  credentialEnvelope: v.union(credentialEnvelopeValidator, v.null()),
  credentialOperation: v.union(credentialOperationValidator, v.null()),
  authorizationAttemptStateDigest: v.union(v.string(), v.null()),
}

export const connectionValidator = v.object(connectionFields)

export const commandResultValidator = v.union(
  v.object({
    _tag: v.literal('ConnectionInitialized'),
    generation: v.literal(0),
    revision: v.literal(0),
  }),
  v.object({
    _tag: v.literal('AuthorizationAttemptCreated'),
    generation: v.number(),
    revision: v.number(),
  }),
  v.object({
    _tag: v.literal('AuthorizationAttemptAdmitted'),
    generation: v.number(),
    revision: v.number(),
    operation: credentialOperationValidator,
  }),
  v.object({
    _tag: v.literal('AuthorizationAttemptClosed'),
    generation: v.number(),
    revision: v.number(),
  }),
  v.object({
    _tag: v.literal('AuthorizationCompleted'),
    generation: v.number(),
    revision: v.number(),
  }),
  v.object({
    _tag: v.literal('SelfClientExchangeAdmitted'),
    generation: v.number(),
    revision: v.number(),
    operation: selfClientExchangeOperationValidator,
  }),
  v.object({
    _tag: v.literal('SelfClientExchangeCompleted'),
    generation: v.number(),
    revision: v.number(),
  }),
  v.object({
    _tag: v.literal('CredentialSaved'),
    generation: v.number(),
    revision: v.number(),
  }),
  v.object({
    _tag: v.literal('CredentialOperationAcquired'),
    generation: v.number(),
    revision: v.number(),
    operation: credentialOperationValidator,
  }),
  v.object({
    _tag: v.literal('CredentialOperationDispatchReserved'),
    generation: v.number(),
    revision: v.number(),
  }),
  v.object({
    _tag: v.literal('CredentialOperationCompleted'),
    generation: v.number(),
    revision: v.number(),
  }),
  v.object({
    _tag: v.literal('CredentialOperationFailed'),
    generation: v.number(),
    revision: v.number(),
    reason: v.union(v.literal('ProviderRejected'), v.literal('ProviderFailure')),
  }),
  v.object({
    _tag: v.literal('CredentialOperationInterventionMarked'),
    generation: v.number(),
    revision: v.number(),
  }),
  v.object({
    _tag: v.literal('CredentialInvalidated'),
    generation: v.number(),
    revision: v.number(),
  }),
  v.object({
    _tag: v.literal('ConnectionRemoved'),
    generation: v.number(),
    revision: v.number(),
  }),
  v.object({
    _tag: v.literal('StoreConflict'),
    reason: v.union(v.literal('RequestIdReused'), v.literal('ConditionChanged')),
  }),
)

export const commandKindValidator = v.union(
  v.literal('InitializeConnection'),
  v.literal('CreateAuthorizationAttempt'),
  v.literal('AdmitAuthorizationAttempt'),
  v.literal('CloseAuthorizationAttempt'),
  v.literal('CompleteAuthorizationAttempt'),
  v.literal('AdmitSelfClientExchange'),
  v.literal('CompleteSelfClientExchange'),
  v.literal('SaveCredential'),
  v.literal('AcquireCredentialOperation'),
  v.literal('ReserveCredentialOperationDispatch'),
  v.literal('CompleteCredentialOperation'),
  v.literal('RecordCredentialOperationFailure'),
  v.literal('MarkCredentialOperationIntervention'),
  v.literal('InvalidateCredential'),
  v.literal('RemoveConnection'),
)

export default defineSchema({
  connections: defineTable(connectionFields).index('by_storage_key', ['storageKey']),
  attempts: defineTable({
    ...authorizationAttemptValidator.fields,
    storageKey: v.string(),
    state: authorizationAttemptStateValidator,
    retentionState: v.union(v.literal('Prepared'), v.literal('Admitted'), v.literal('Closed')),
    closedAt: v.union(v.number(), v.null()),
  })
    .index('by_namespace_state', ['key.namespace', 'stateDigest'])
    .index('by_schema_state_expiry', ['schemaVersion', 'retentionState', 'expiresAt'])
    .index('by_schema_state_closed_at', ['schemaVersion', 'retentionState', 'closedAt']),
  receipts: defineTable({
    schemaVersion: componentSchemaVersionValidator,
    namespace: v.string(),
    requestId: v.string(),
    commandKind: commandKindValidator,
    inputDigest: v.string(),
    result: commandResultValidator,
    createdAt: v.number(),
  })
    .index('by_namespace_request', ['namespace', 'requestId'])
    .index('by_schema_created_at', ['schemaVersion', 'createdAt']),
})
