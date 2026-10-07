import type {
  AuthorizationAdmission,
  AuthorizationAttempt,
  ConnectionKey,
  CredentialOperation,
  StoreCommandResult,
} from '../../core/contracts/store.js'
import type {
  StoredAuthorizationAttempt,
  StoredAuthorizationAttemptState,
  StoredCommandKind,
  StoredConnection,
  StoredReceipt,
} from './transition-kernel.js'

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError('Invalid persisted record')
  }
  return value as Record<string, unknown>
}

function string(value: unknown): string {
  if (typeof value !== 'string') throw new TypeError('Invalid persisted record')
  return value
}

function nullableString(value: unknown): string | null {
  return value === null ? null : string(value)
}

function finiteNumber(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new TypeError('Invalid persisted record')
  }
  return value
}

function nonNegativeInteger(value: unknown): number {
  const decoded = finiteNumber(value)
  if (!Number.isSafeInteger(decoded) || decoded < 0) {
    throw new TypeError('Invalid persisted record')
  }
  return decoded
}

function nullableFiniteNumber(value: unknown): number | null {
  return value === null ? null : finiteNumber(value)
}

function literal<Value extends string | number>(value: unknown, expected: Value): Value {
  if (value !== expected) throw new TypeError('Invalid persisted record')
  return expected
}

function connectionKey(value: unknown): ConnectionKey {
  const candidate = record(value)
  return {
    namespace: string(candidate.namespace),
    providerId: string(candidate.providerId),
    connectionId: string(candidate.connectionId),
  }
}

function sameConnectionKey(left: ConnectionKey, right: ConnectionKey): boolean {
  return (
    left.namespace === right.namespace &&
    left.providerId === right.providerId &&
    left.connectionId === right.connectionId
  )
}

function credentialEnvelope(value: unknown) {
  const candidate = record(value)
  return {
    version: literal(candidate.version, 1),
    algorithm: literal(candidate.algorithm, 'AES-256-GCM'),
    keyId: string(candidate.keyId),
    iv: string(candidate.iv),
    ciphertext: string(candidate.ciphertext),
  } as const
}

function authorizationAdmission(value: unknown): AuthorizationAdmission {
  const candidate = record(value)
  const intent = candidate.intent
  if (intent !== 'enroll' && intent !== 'replace') {
    throw new TypeError('Invalid persisted record')
  }
  const admission: AuthorizationAdmission = {
    stateDigest: string(candidate.stateDigest),
    key: connectionKey(candidate.key),
    intent,
    generation: nonNegativeInteger(candidate.generation),
    admissionId: string(candidate.admissionId),
    admittedAt: finiteNumber(candidate.admittedAt),
    admissionExpiresAt: finiteNumber(candidate.admissionExpiresAt),
  }
  if (admission.admissionExpiresAt <= admission.admittedAt) {
    throw new TypeError('Invalid persisted record')
  }
  return admission
}

function credentialOperation(value: unknown): CredentialOperation {
  const candidate = record(value)
  const kind = candidate.kind
  if (
    kind !== 'refresh' &&
    kind !== 'authorization-exchange' &&
    kind !== 'client-credentials-acquisition' &&
    kind !== 'self-client-exchange'
  ) {
    throw new TypeError('Invalid persisted record')
  }
  const phaseValue = record(candidate.phase)
  let phase: CredentialOperation['phase']
  switch (phaseValue._tag) {
    case 'OwnedBeforeDispatch':
      phase = {
        _tag: 'OwnedBeforeDispatch',
        ownershipFence: string(phaseValue.ownershipFence),
        leaseExpiresAt: finiteNumber(phaseValue.leaseExpiresAt),
      }
      break
    case 'DispatchPossible':
      phase = {
        _tag: 'DispatchPossible',
        ownershipFence: string(phaseValue.ownershipFence),
        leaseExpiresAt: finiteNumber(phaseValue.leaseExpiresAt),
        reservedAt: finiteNumber(phaseValue.reservedAt),
      }
      break
    case 'KnownFailure': {
      const reason = phaseValue.reason
      if (reason !== 'ProviderRejected' && reason !== 'ProviderFailure') {
        throw new TypeError('Invalid persisted record')
      }
      let recovery: import('../../core/contracts/recovery.js').CredentialFailureRecovery | undefined
      if (phaseValue.recovery !== undefined) {
        if (reason !== 'ProviderFailure') throw new TypeError('Invalid persisted record')
        if (phaseValue.recovery === 'NotDispatched') {
          if (kind !== 'refresh' && kind !== 'client-credentials-acquisition')
            throw new TypeError('Invalid persisted record')
          recovery = 'NotDispatched'
        } else {
          const evidence = record(phaseValue.recovery)
          if (kind !== 'refresh' || evidence._tag !== 'ReplaySafe')
            throw new TypeError('Invalid persisted record')
          recovery = {
            _tag: 'ReplaySafe',
            retryUntil: finiteNumber(evidence.retryUntil),
            retryAt: finiteNumber(evidence.retryAt),
          }
          if (
            recovery.retryAt < 0 ||
            recovery.retryAt > recovery.retryUntil ||
            recovery.retryUntil <= finiteNumber(phaseValue.failedAt)
          )
            throw new TypeError('Invalid persisted record')
        }
      }
      phase = {
        _tag: 'KnownFailure',
        reason,
        failedAt: finiteNumber(phaseValue.failedAt),
        ...(recovery === undefined ? {} : { recovery }),
      }
      break
    }
    case 'InterventionRequired': {
      const reason = phaseValue.reason
      if (
        reason !== 'ProviderOutcomeUnknown' &&
        reason !== 'KnownResponseNotPersisted' &&
        reason !== 'DispatchOwnerExpired' &&
        reason !== 'RecoveryLimitExceeded'
      ) {
        throw new TypeError('Invalid persisted record')
      }
      phase = {
        _tag: 'InterventionRequired',
        reason,
        markedAt: finiteNumber(phaseValue.markedAt),
      }
      break
    }
    default:
      throw new TypeError('Invalid persisted record')
  }
  const baseOperation = {
    schemaVersion: literal(candidate.schemaVersion, 1),
    operationId: string(candidate.operationId),
    generation: nonNegativeInteger(candidate.generation),
    observedRevision: nonNegativeInteger(candidate.observedRevision),
    startedAt: finiteNumber(candidate.startedAt),
    recoveryDeadline: finiteNumber(candidate.recoveryDeadline),
    transferCount: nonNegativeInteger(candidate.transferCount),
    transferLimit: nonNegativeInteger(candidate.transferLimit),
    ...(candidate.replayUntil === undefined
      ? {}
      : { replayUntil: finiteNumber(candidate.replayUntil) }),
    phase,
  }
  let operation: CredentialOperation
  if (kind === 'self-client-exchange') {
    const intent = candidate.intent
    if (intent !== 'enroll' && intent !== 'replace') throw new TypeError('Invalid persisted record')
    operation = { ...baseOperation, kind, intent }
  } else {
    if (candidate.intent !== undefined) throw new TypeError('Invalid persisted record')
    operation = { ...baseOperation, kind }
  }
  if (
    operation.recoveryDeadline <= operation.startedAt ||
    operation.transferCount > operation.transferLimit ||
    (operation.replayUntil !== undefined && (kind !== 'refresh' || operation.replayUntil < 0)) ||
    (phase._tag === 'KnownFailure' &&
      typeof phase.recovery === 'object' &&
      phase.recovery.retryUntil !== operation.replayUntil)
  ) {
    throw new TypeError('Invalid persisted record')
  }
  return operation
}

function authorizationAttempt(value: unknown): AuthorizationAttempt {
  const candidate = record(value)
  const intent = candidate.intent
  if (intent !== 'enroll' && intent !== 'replace') {
    throw new TypeError('Invalid persisted record')
  }
  const attempt: AuthorizationAttempt = {
    schemaVersion: literal(candidate.schemaVersion, 1),
    stateDigest: string(candidate.stateDigest),
    key: connectionKey(candidate.key),
    generation: nonNegativeInteger(candidate.generation),
    intent,
    bindingDigest: string(candidate.bindingDigest),
    pkceVerifierEnvelope: credentialEnvelope(candidate.pkceVerifierEnvelope),
    createdAt: finiteNumber(candidate.createdAt),
    expiresAt: finiteNumber(candidate.expiresAt),
  }
  if (attempt.expiresAt <= attempt.createdAt) throw new TypeError('Invalid persisted record')
  return attempt
}

function authorizationAttemptState(value: unknown): StoredAuthorizationAttemptState {
  const candidate = record(value)
  switch (candidate._tag) {
    case 'Prepared':
      return { _tag: 'Prepared' }
    case 'Admitted':
      return { _tag: 'Admitted', admission: authorizationAdmission(candidate.admission) }
    case 'Closed': {
      const reason = candidate.reason
      if (reason !== 'ProviderDenied' && reason !== 'Completed' && reason !== 'Superseded') {
        throw new TypeError('Invalid persisted record')
      }
      return { _tag: 'Closed', reason }
    }
    default:
      throw new TypeError('Invalid persisted record')
  }
}

function commonResult(value: Record<string, unknown>) {
  return {
    generation: nonNegativeInteger(value.generation),
    revision: nonNegativeInteger(value.revision),
  }
}

function storeCommandResult(value: unknown): StoreCommandResult {
  const candidate = record(value)
  switch (candidate._tag) {
    case 'ConnectionInitialized':
      return {
        _tag: 'ConnectionInitialized',
        generation: literal(candidate.generation, 0),
        revision: literal(candidate.revision, 0),
      }
    case 'AuthorizationAttemptCreated':
      return { _tag: 'AuthorizationAttemptCreated', ...commonResult(candidate) }
    case 'AuthorizationAttemptAdmitted':
      return {
        _tag: 'AuthorizationAttemptAdmitted',
        ...commonResult(candidate),
        operation: credentialOperation(candidate.operation),
      }
    case 'AuthorizationAttemptClosed':
      return { _tag: 'AuthorizationAttemptClosed', ...commonResult(candidate) }
    case 'AuthorizationCompleted':
      return { _tag: 'AuthorizationCompleted', ...commonResult(candidate) }
    case 'SelfClientExchangeAdmitted': {
      const operation = credentialOperation(candidate.operation)
      if (operation.kind !== 'self-client-exchange') throw new TypeError('Invalid persisted record')
      return {
        _tag: 'SelfClientExchangeAdmitted',
        ...commonResult(candidate),
        operation,
      }
    }
    case 'SelfClientExchangeCompleted':
      return { _tag: 'SelfClientExchangeCompleted', ...commonResult(candidate) }
    case 'CredentialSaved':
      return { _tag: 'CredentialSaved', ...commonResult(candidate) }
    case 'CredentialOperationAcquired':
      return {
        _tag: 'CredentialOperationAcquired',
        ...commonResult(candidate),
        operation: credentialOperation(candidate.operation),
      }
    case 'CredentialOperationDispatchReserved':
      return { _tag: 'CredentialOperationDispatchReserved', ...commonResult(candidate) }
    case 'CredentialOperationCompleted':
      return { _tag: 'CredentialOperationCompleted', ...commonResult(candidate) }
    case 'CredentialOperationFailed': {
      const reason = candidate.reason
      if (reason !== 'ProviderRejected' && reason !== 'ProviderFailure') {
        throw new TypeError('Invalid persisted record')
      }
      return { _tag: 'CredentialOperationFailed', ...commonResult(candidate), reason }
    }
    case 'CredentialOperationInterventionMarked':
      return { _tag: 'CredentialOperationInterventionMarked', ...commonResult(candidate) }
    case 'CredentialInvalidated':
      return { _tag: 'CredentialInvalidated', ...commonResult(candidate) }
    case 'ConnectionRemoved':
      return { _tag: 'ConnectionRemoved', ...commonResult(candidate) }
    case 'StoreConflict': {
      const reason = candidate.reason
      if (reason !== 'RequestIdReused' && reason !== 'ConditionChanged') {
        throw new TypeError('Invalid persisted record')
      }
      return { _tag: 'StoreConflict', reason }
    }
    default:
      throw new TypeError('Invalid persisted record')
  }
}

const resultTags: Readonly<Record<StoredCommandKind, StoreCommandResult['_tag']>> = {
  InitializeConnection: 'ConnectionInitialized',
  CreateAuthorizationAttempt: 'AuthorizationAttemptCreated',
  AdmitAuthorizationAttempt: 'AuthorizationAttemptAdmitted',
  CloseAuthorizationAttempt: 'AuthorizationAttemptClosed',
  CompleteAuthorizationAttempt: 'AuthorizationCompleted',
  AdmitSelfClientExchange: 'SelfClientExchangeAdmitted',
  CompleteSelfClientExchange: 'SelfClientExchangeCompleted',
  SaveCredential: 'CredentialSaved',
  AcquireCredentialOperation: 'CredentialOperationAcquired',
  ReserveCredentialOperationDispatch: 'CredentialOperationDispatchReserved',
  CompleteCredentialOperation: 'CredentialOperationCompleted',
  RecordCredentialOperationFailure: 'CredentialOperationFailed',
  MarkCredentialOperationIntervention: 'CredentialOperationInterventionMarked',
  InvalidateCredential: 'CredentialInvalidated',
  RemoveConnection: 'ConnectionRemoved',
}

function commandKind(value: unknown): StoredCommandKind {
  if (typeof value !== 'string' || !(value in resultTags)) {
    throw new TypeError('Invalid persisted record')
  }
  return value as StoredCommandKind
}

export function decodeConnectionJson(json: unknown): StoredConnection {
  const candidate = record(parseJson(json))
  const authorizationValue = record(candidate.authorization)
  const operation =
    candidate.credentialOperation === null
      ? null
      : credentialOperation(candidate.credentialOperation)
  const base = {
    schemaVersion: literal(candidate.schemaVersion, 1),
    key: connectionKey(candidate.key),
    generation: nonNegativeInteger(candidate.generation),
    revision: nonNegativeInteger(candidate.revision),
    credentialOperation: operation,
    authorizationAttemptStateDigest: nullableString(candidate.authorizationAttemptStateDigest),
  }
  if (
    operation !== null &&
    (operation.generation !== base.generation || operation.observedRevision > base.revision)
  ) {
    throw new TypeError('Invalid persisted record')
  }
  if (authorizationValue._tag === 'NotAuthorized' && candidate.credentialEnvelope === null) {
    return {
      ...base,
      authorization: { _tag: 'NotAuthorized' },
      credentialEnvelope: null,
    }
  }
  if (authorizationValue._tag === 'Authorized' && candidate.credentialEnvelope !== null) {
    return {
      ...base,
      authorization: {
        _tag: 'Authorized',
        credentialExpiresAt: nullableFiniteNumber(authorizationValue.credentialExpiresAt),
        credentialAcquiredAt:
          authorizationValue.credentialAcquiredAt === undefined
            ? null
            : nullableFiniteNumber(authorizationValue.credentialAcquiredAt),
      },
      credentialEnvelope: credentialEnvelope(candidate.credentialEnvelope),
    }
  }
  throw new TypeError('Invalid persisted record')
}

export function decodeAttemptJson(json: unknown): StoredAuthorizationAttempt {
  const candidate = record(parseJson(json))
  const attempt = authorizationAttempt(candidate.attempt)
  const state = authorizationAttemptState(candidate.state)
  const closedAt = nullableFiniteNumber(candidate.closedAt)
  if ((state._tag === 'Closed') !== (closedAt !== null)) {
    throw new TypeError('Invalid persisted record')
  }
  if (
    state._tag === 'Admitted' &&
    (state.admission.stateDigest !== attempt.stateDigest ||
      !sameConnectionKey(state.admission.key, attempt.key) ||
      state.admission.intent !== attempt.intent ||
      state.admission.generation !== attempt.generation ||
      state.admission.admittedAt >= attempt.expiresAt)
  ) {
    throw new TypeError('Invalid persisted record')
  }
  return { attempt, state, closedAt }
}

export function decodeReceipt(
  storedCommandKind: unknown,
  inputDigest: unknown,
  resultJson: unknown,
): StoredReceipt {
  const decodedCommandKind = commandKind(storedCommandKind)
  const result = storeCommandResult(parseJson(resultJson))
  if (result._tag !== 'StoreConflict' && result._tag !== resultTags[decodedCommandKind]) {
    throw new TypeError('Invalid persisted record')
  }
  return {
    commandKind: decodedCommandKind,
    inputDigest: string(inputDigest),
    result,
  }
}

export function parseJson(json: unknown): unknown {
  if (typeof json !== 'string') throw new TypeError('Invalid persisted record')
  return JSON.parse(json) as unknown
}

export function isSchemaVersionOne(value: unknown): boolean {
  return value === 1 || value === 1n
}
