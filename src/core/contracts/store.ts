import type { Effect, Redacted } from 'effect'
import type { CredentialEnvelope, EncryptionContext } from './encryptor.js'

export interface ConnectionKey {
  readonly namespace: string
  readonly providerId: string
  readonly connectionId: string
}

export type ProtectedCredentialEnvelope = CredentialEnvelope

export type AuthorizationCondition =
  | { readonly _tag: 'NotAuthorized' }
  | {
      readonly _tag: 'Authorized'
      readonly credentialExpiresAt: number | null
    }

export type CredentialOperationKind =
  | 'refresh'
  | 'authorization-exchange'
  | 'client-credentials-acquisition'
  | 'self-client-exchange'

export type CredentialOperationPhase =
  | {
      readonly _tag: 'OwnedBeforeDispatch'
      readonly ownershipFence: string
      readonly leaseExpiresAt: number
    }
  | {
      readonly _tag: 'DispatchPossible'
      readonly ownershipFence: string
      readonly leaseExpiresAt: number
      readonly reservedAt: number
    }
  | {
      readonly _tag: 'KnownFailure'
      readonly reason: 'ProviderRejected' | 'ProviderFailure'
      readonly failedAt: number
    }
  | {
      readonly _tag: 'InterventionRequired'
      readonly reason:
        | 'ProviderOutcomeUnknown'
        | 'KnownResponseNotPersisted'
        | 'DispatchOwnerExpired'
        | 'RecoveryLimitExceeded'
      readonly markedAt: number
    }

interface CredentialOperationBase {
  readonly schemaVersion: 1
  readonly operationId: string
  readonly generation: number
  readonly observedRevision: number
  readonly startedAt: number
  readonly recoveryDeadline: number
  readonly transferCount: number
  readonly transferLimit: number
  readonly phase: CredentialOperationPhase
}

export type SelfClientExchangeOperation = CredentialOperationBase & {
  readonly kind: 'self-client-exchange'
  readonly intent: CredentialIntent
}

export type CredentialOperation =
  | (CredentialOperationBase & {
      readonly kind: 'refresh' | 'authorization-exchange' | 'client-credentials-acquisition'
    })
  | SelfClientExchangeOperation

interface ConnectionSnapshotBase {
  readonly schemaVersion: 1
  readonly key: ConnectionKey
  readonly generation: number
  readonly revision: number
  readonly credentialOperation: CredentialOperation | null
}

export type ConnectionSnapshot = ConnectionSnapshotBase &
  (
    | {
        readonly authorization: { readonly _tag: 'NotAuthorized' }
        readonly credentialEnvelope: null
      }
    | {
        readonly authorization: {
          readonly _tag: 'Authorized'
          readonly credentialExpiresAt: number | null
          readonly credentialAcquiredAt?: number | null
        }
        readonly credentialEnvelope: ProtectedCredentialEnvelope
      }
  )

export interface StoredConnectionInspection {
  readonly schemaVersion: 1
  readonly key: ConnectionKey
  readonly savedAuthorization: boolean
  readonly credentialWork: 'idle' | 'pending' | 'intervention-required' | 'known-failure'
}

export type CredentialIntent = 'enroll' | 'replace'
export type AuthorizationIntent = CredentialIntent

export interface AuthorizationAttempt {
  readonly schemaVersion: 1
  readonly stateDigest: string
  readonly key: ConnectionKey
  readonly generation: number
  readonly intent: AuthorizationIntent
  readonly bindingDigest: string
  readonly pkceVerifierEnvelope: ProtectedCredentialEnvelope
  readonly createdAt: number
  readonly expiresAt: number
}

export interface AuthorizationAttemptLookup {
  readonly namespace: string
  readonly stateDigest: string
  readonly bindingDigest: string
  readonly now: number
}

export interface AuthorizationAdmission {
  readonly stateDigest: string
  readonly key: ConnectionKey
  readonly intent: AuthorizationIntent
  readonly generation: number
  readonly admissionId: string
  readonly admittedAt: number
  readonly admissionExpiresAt: number
}

export interface MutationRequest {
  readonly requestId: string
  readonly inputDigest: string
}

export interface InitializeConnectionCommand {
  readonly _tag: 'InitializeConnection'
  readonly request: MutationRequest
  readonly key: ConnectionKey
}

export interface CreateAuthorizationAttemptCommand {
  readonly _tag: 'CreateAuthorizationAttempt'
  readonly request: MutationRequest
  readonly attempt: AuthorizationAttempt
}

export interface AdmitAuthorizationAttemptCommand {
  readonly _tag: 'AdmitAuthorizationAttempt'
  readonly request: MutationRequest
  readonly admission: AuthorizationAdmission
  readonly ownershipFence: string
  readonly leaseExpiresAt: number
  readonly operation: CredentialOperationProposal
}

export interface CloseAuthorizationAttemptCommand {
  readonly _tag: 'CloseAuthorizationAttempt'
  readonly request: MutationRequest
  readonly stateDigest: string
  readonly key: ConnectionKey
  readonly expectedGeneration: number
  readonly closedAt: number
  readonly reason: 'ProviderDenied'
}

export interface CompleteAuthorizationAttemptCommand {
  readonly _tag: 'CompleteAuthorizationAttempt'
  readonly request: MutationRequest
  readonly admission: AuthorizationAdmission
  readonly expectedRevision: number
  readonly operationId: string
  readonly ownershipFence: string
  readonly credentialEnvelope: ProtectedCredentialEnvelope
  readonly credentialExpiresAt: number | null
  readonly completedAt: number
}

export interface SelfClientExchangeProposal {
  readonly operationId: string
  readonly startedAt: number
  readonly recoveryDeadline: number
  readonly transferLimit: number
}

export interface AdmitSelfClientExchangeCommand {
  readonly _tag: 'AdmitSelfClientExchange'
  readonly request: MutationRequest
  readonly key: ConnectionKey
  readonly expectedGeneration: number
  readonly expectedRevision: number
  readonly intent: CredentialIntent
  readonly acquiredAt: number
  readonly ownershipFence: string
  readonly leaseExpiresAt: number
  readonly proposal: SelfClientExchangeProposal
}

export interface CompleteSelfClientExchangeCommand {
  readonly _tag: 'CompleteSelfClientExchange'
  readonly request: MutationRequest
  readonly key: ConnectionKey
  readonly expectedGeneration: number
  readonly expectedRevision: number
  readonly operationId: string
  readonly ownershipFence: string
  readonly credentialEnvelope: ProtectedCredentialEnvelope
  readonly credentialExpiresAt: number | null
  readonly completedAt: number
}

export type CredentialOperationProposalKind = Exclude<
  CredentialOperationKind,
  'self-client-exchange'
>

export interface CredentialOperationProposal {
  readonly operationId: string
  readonly kind: CredentialOperationProposalKind
  readonly startedAt: number
  readonly recoveryDeadline: number
  readonly transferLimit: number
}

export interface AcquireCredentialOperationCommand {
  readonly _tag: 'AcquireCredentialOperation'
  readonly request: MutationRequest
  readonly key: ConnectionKey
  readonly expectedGeneration: number
  readonly expectedRevision: number
  readonly acquiredAt: number
  readonly ownershipFence: string
  readonly leaseExpiresAt: number
  readonly proposal: CredentialOperationProposal
}

export interface ReserveCredentialOperationDispatchCommand {
  readonly _tag: 'ReserveCredentialOperationDispatch'
  readonly request: MutationRequest
  readonly key: ConnectionKey
  readonly expectedGeneration: number
  readonly expectedRevision: number
  readonly operationId: string
  readonly ownershipFence: string
  readonly reservedAt: number
}

export interface CompleteCredentialOperationCommand {
  readonly _tag: 'CompleteCredentialOperation'
  readonly request: MutationRequest
  readonly key: ConnectionKey
  readonly expectedGeneration: number
  readonly expectedRevision: number
  readonly operationId: string
  readonly ownershipFence: string
  readonly credentialEnvelope: ProtectedCredentialEnvelope
  readonly credentialExpiresAt: number | null
  readonly credentialAcquiredAt?: number | null
  readonly completedAt: number
}

export interface RecordCredentialOperationFailureCommand {
  readonly _tag: 'RecordCredentialOperationFailure'
  readonly request: MutationRequest
  readonly key: ConnectionKey
  readonly expectedGeneration: number
  readonly expectedRevision: number
  readonly operationId: string
  readonly ownershipFence: string
  readonly failedAt: number
  readonly reason: 'ProviderRejected' | 'ProviderFailure'
}

export interface MarkCredentialOperationInterventionCommand {
  readonly _tag: 'MarkCredentialOperationIntervention'
  readonly request: MutationRequest
  readonly key: ConnectionKey
  readonly expectedGeneration: number
  readonly expectedRevision: number
  readonly operationId: string
  readonly ownershipFence: string | null
  readonly markedAt: number
  readonly reason:
    | 'ProviderOutcomeUnknown'
    | 'KnownResponseNotPersisted'
    | 'DispatchOwnerExpired'
    | 'RecoveryLimitExceeded'
}

export interface SaveCredentialCommand {
  readonly _tag: 'SaveCredential'
  readonly request: MutationRequest
  readonly key: ConnectionKey
  readonly expectedGeneration: number
  readonly expectedRevision: number
  readonly intent: CredentialIntent
  readonly credentialEnvelope: ProtectedCredentialEnvelope
  readonly credentialExpiresAt: number | null
  readonly credentialAcquiredAt?: number | null
}

export interface InvalidateCredentialCommand {
  readonly _tag: 'InvalidateCredential'
  readonly request: MutationRequest
  readonly key: ConnectionKey
  readonly expectedGeneration: number
  readonly expectedRevision: number
}

export interface RemoveConnectionCommand {
  readonly _tag: 'RemoveConnection'
  readonly request: MutationRequest
  readonly key: ConnectionKey
  readonly expectedGeneration: number
  readonly expectedRevision: number
  readonly removedAt: number
}

export type StoreCommand =
  | InitializeConnectionCommand
  | CreateAuthorizationAttemptCommand
  | AdmitAuthorizationAttemptCommand
  | CloseAuthorizationAttemptCommand
  | CompleteAuthorizationAttemptCommand

export type CredentialOperationCommand =
  | SaveCredentialCommand
  | AdmitSelfClientExchangeCommand
  | CompleteSelfClientExchangeCommand
  | AcquireCredentialOperationCommand
  | ReserveCredentialOperationDispatchCommand
  | CompleteCredentialOperationCommand
  | RecordCredentialOperationFailureCommand
  | MarkCredentialOperationInterventionCommand
  | InvalidateCredentialCommand
  | RemoveConnectionCommand

export type StoreCommandInput =
  | Omit<InitializeConnectionCommand, 'request'>
  | Omit<CreateAuthorizationAttemptCommand, 'request'>
  | Omit<AdmitAuthorizationAttemptCommand, 'request'>
  | Omit<CloseAuthorizationAttemptCommand, 'request'>
  | Omit<CompleteAuthorizationAttemptCommand, 'request'>

export type CredentialOperationCommandInput =
  | Omit<SaveCredentialCommand, 'request'>
  | Omit<AdmitSelfClientExchangeCommand, 'request'>
  | Omit<CompleteSelfClientExchangeCommand, 'request'>
  | Omit<AcquireCredentialOperationCommand, 'request'>
  | Omit<ReserveCredentialOperationDispatchCommand, 'request'>
  | Omit<CompleteCredentialOperationCommand, 'request'>
  | Omit<RecordCredentialOperationFailureCommand, 'request'>
  | Omit<MarkCredentialOperationInterventionCommand, 'request'>
  | Omit<InvalidateCredentialCommand, 'request'>
  | Omit<RemoveConnectionCommand, 'request'>

export interface ConnectionInitialized {
  readonly _tag: 'ConnectionInitialized'
  readonly generation: 0
  readonly revision: 0
}

export interface AuthorizationAttemptCreated {
  readonly _tag: 'AuthorizationAttemptCreated'
  readonly generation: number
  readonly revision: number
}

export interface AuthorizationAttemptAdmitted {
  readonly _tag: 'AuthorizationAttemptAdmitted'
  readonly generation: number
  readonly revision: number
  readonly operation: CredentialOperation
}

export interface AuthorizationAttemptClosed {
  readonly _tag: 'AuthorizationAttemptClosed'
  readonly generation: number
  readonly revision: number
}

export interface AuthorizationCompleted {
  readonly _tag: 'AuthorizationCompleted'
  readonly generation: number
  readonly revision: number
}

export interface SelfClientExchangeAdmitted {
  readonly _tag: 'SelfClientExchangeAdmitted'
  readonly generation: number
  readonly revision: number
  readonly operation: SelfClientExchangeOperation
}

export interface SelfClientExchangeCompleted {
  readonly _tag: 'SelfClientExchangeCompleted'
  readonly generation: number
  readonly revision: number
}

export interface CredentialOperationAcquired {
  readonly _tag: 'CredentialOperationAcquired'
  readonly generation: number
  readonly revision: number
  readonly operation: CredentialOperation
}

export interface CredentialOperationDispatchReserved {
  readonly _tag: 'CredentialOperationDispatchReserved'
  readonly generation: number
  readonly revision: number
}

export interface CredentialOperationCompleted {
  readonly _tag: 'CredentialOperationCompleted'
  readonly generation: number
  readonly revision: number
}

export interface CredentialOperationFailed {
  readonly _tag: 'CredentialOperationFailed'
  readonly generation: number
  readonly revision: number
  readonly reason: 'ProviderRejected' | 'ProviderFailure'
}

export interface CredentialOperationInterventionMarked {
  readonly _tag: 'CredentialOperationInterventionMarked'
  readonly generation: number
  readonly revision: number
}

export interface CredentialSaved {
  readonly _tag: 'CredentialSaved'
  readonly generation: number
  readonly revision: number
}

export interface CredentialInvalidated {
  readonly _tag: 'CredentialInvalidated'
  readonly generation: number
  readonly revision: number
}

export interface ConnectionRemoved {
  readonly _tag: 'ConnectionRemoved'
  readonly generation: number
  readonly revision: number
}

export interface StoreConflict {
  readonly _tag: 'StoreConflict'
  readonly reason: 'RequestIdReused' | 'ConditionChanged'
}

export type StoreCommandResult =
  | ConnectionInitialized
  | AuthorizationAttemptCreated
  | AuthorizationAttemptAdmitted
  | AuthorizationAttemptClosed
  | AuthorizationCompleted
  | SelfClientExchangeAdmitted
  | SelfClientExchangeCompleted
  | CredentialOperationAcquired
  | CredentialOperationDispatchReserved
  | CredentialOperationCompleted
  | CredentialOperationFailed
  | CredentialOperationInterventionMarked
  | CredentialSaved
  | CredentialInvalidated
  | ConnectionRemoved
  | StoreConflict

export interface ConnectionStore<
  Error,
  Requirements,
  InspectionError = Error,
  InspectionRequirements = Requirements,
> {
  readonly readConnection: (
    key: ConnectionKey,
  ) => Effect.Effect<ConnectionSnapshot | null, Error, Requirements>
  readonly inspectConnection: (
    key: ConnectionKey,
  ) => Effect.Effect<StoredConnectionInspection | null, InspectionError, InspectionRequirements>
  readonly readAuthorizationAttempt: (
    lookup: AuthorizationAttemptLookup,
  ) => Effect.Effect<AuthorizationAttempt | null, Error, Requirements>
  readonly protect: (
    plaintext: Redacted.Redacted<string>,
    context: EncryptionContext,
  ) => Effect.Effect<ProtectedCredentialEnvelope, Error, Requirements>
  readonly unprotect: (
    envelope: unknown,
    context: EncryptionContext,
  ) => Effect.Effect<Redacted.Redacted<string>, Error, Requirements>
  readonly execute: (
    command: StoreCommand,
  ) => Effect.Effect<StoreCommandResult, Error, Requirements>
  readonly executeCredentialOperation: (
    command: CredentialOperationCommand,
  ) => Effect.Effect<StoreCommandResult, Error, Requirements>
}

export function connectionStorageKey(key: ConnectionKey): string {
  return JSON.stringify([key.namespace, key.providerId, key.connectionId])
}

export function credentialOperationCommandKey(command: CredentialOperationCommand): ConnectionKey {
  return command.key
}

export function storeCommandKey(command: StoreCommand): ConnectionKey {
  switch (command._tag) {
    case 'InitializeConnection':
    case 'CloseAuthorizationAttempt':
      return command.key
    case 'CreateAuthorizationAttempt':
      return command.attempt.key
    case 'AdmitAuthorizationAttempt':
    case 'CompleteAuthorizationAttempt':
      return command.admission.key
  }
}

function canonicalize(value: unknown): unknown {
  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'boolean' ||
    (typeof value === 'number' && Number.isFinite(value))
  ) {
    return value
  }
  if (Array.isArray(value)) return value.map(canonicalize)
  if (typeof value === 'object') {
    const record: Record<string, unknown> = {}
    for (const key of Object.keys(value).sort()) {
      record[key] = canonicalize(Reflect.get(value, key))
    }
    return record
  }
  throw new TypeError('Store command inputs must contain only serializable values')
}

export function canonicalStoreInput(value: unknown): string {
  return JSON.stringify(canonicalize(value))
}

export async function digestStoreInput(value: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(canonicalStoreInput(value))
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, '0')).join('')
}
