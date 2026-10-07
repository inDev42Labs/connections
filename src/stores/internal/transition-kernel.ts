import type {
  AuthorizationAdmission,
  AuthorizationAttempt,
  AuthorizationAttemptLookup,
  ConnectionKey,
  ConnectionSnapshot,
  CredentialOperation,
  CredentialOperationCommand,
  SelfClientExchangeOperation,
  StoredConnectionInspection,
  StoreCommand,
  StoreCommandResult,
} from '../../core/contracts/store.js'

export type StoredCommand = StoreCommand | CredentialOperationCommand
export type StoredCommandKind = StoredCommand['_tag']

export interface StoredReceipt {
  readonly commandKind: StoredCommandKind
  readonly inputDigest: string
  readonly result: StoreCommandResult
}

export type StoredAuthorizationAttemptState =
  | { readonly _tag: 'Prepared' }
  | { readonly _tag: 'Admitted'; readonly admission: AuthorizationAdmission }
  | {
      readonly _tag: 'Closed'
      readonly reason: 'ProviderDenied' | 'Completed' | 'Superseded'
    }

export interface StoredAuthorizationAttempt {
  readonly attempt: AuthorizationAttempt
  readonly state: StoredAuthorizationAttemptState
  readonly closedAt: number | null
}

export type StoredConnection = ConnectionSnapshot & {
  readonly authorizationAttemptStateDigest: string | null
}

export interface TransitionRecords {
  readonly connection: StoredConnection | null
  readonly attempt: StoredAuthorizationAttempt | null
  readonly selectedAttempt: StoredAuthorizationAttempt | null
  readonly receipt: StoredReceipt | null
}

export interface TransitionWrites {
  readonly connection?: StoredConnection
  readonly attempts?: readonly StoredAuthorizationAttempt[]
  readonly receipt?: StoredReceipt
}

export interface StoreTransition {
  readonly result: StoreCommandResult
  readonly writes: TransitionWrites
}

const conditionChanged = {
  _tag: 'StoreConflict',
  reason: 'ConditionChanged',
} as const
const requestIdReused = {
  _tag: 'StoreConflict',
  reason: 'RequestIdReused',
} as const

function initialConnection(key: ConnectionKey): StoredConnection {
  return {
    schemaVersion: 1,
    key,
    generation: 0,
    revision: 0,
    authorization: { _tag: 'NotAuthorized' },
    credentialEnvelope: null,
    credentialOperation: null,
    authorizationAttemptStateDigest: null,
  }
}

function admissionMatches(left: AuthorizationAdmission, right: AuthorizationAdmission): boolean {
  return (
    left.stateDigest === right.stateDigest &&
    left.key.namespace === right.key.namespace &&
    left.key.providerId === right.key.providerId &&
    left.key.connectionId === right.key.connectionId &&
    left.intent === right.intent &&
    left.generation === right.generation &&
    left.admissionId === right.admissionId &&
    left.admittedAt === right.admittedAt &&
    left.admissionExpiresAt === right.admissionExpiresAt
  )
}

function phaseMatches(
  left: CredentialOperation['phase'],
  right: CredentialOperation['phase'],
): boolean {
  if (left._tag !== right._tag) return false
  switch (left._tag) {
    case 'OwnedBeforeDispatch':
      return (
        right._tag === 'OwnedBeforeDispatch' &&
        left.ownershipFence === right.ownershipFence &&
        left.leaseExpiresAt === right.leaseExpiresAt
      )
    case 'DispatchPossible':
      return (
        right._tag === 'DispatchPossible' &&
        left.ownershipFence === right.ownershipFence &&
        left.leaseExpiresAt === right.leaseExpiresAt &&
        left.reservedAt === right.reservedAt
      )
    case 'KnownFailure':
      return (
        right._tag === 'KnownFailure' &&
        left.reason === right.reason &&
        left.failedAt === right.failedAt &&
        left.recovery === right.recovery
      )
    case 'InterventionRequired':
      return (
        right._tag === 'InterventionRequired' &&
        left.reason === right.reason &&
        left.markedAt === right.markedAt
      )
  }
}

function operationMatches(left: CredentialOperation, right: CredentialOperation): boolean {
  return (
    left.schemaVersion === right.schemaVersion &&
    left.operationId === right.operationId &&
    left.kind === right.kind &&
    (left.kind !== 'self-client-exchange' ||
      (right.kind === 'self-client-exchange' && left.intent === right.intent)) &&
    left.generation === right.generation &&
    left.observedRevision === right.observedRevision &&
    left.startedAt === right.startedAt &&
    left.recoveryDeadline === right.recoveryDeadline &&
    left.transferCount === right.transferCount &&
    left.transferLimit === right.transferLimit &&
    phaseMatches(left.phase, right.phase)
  )
}

function receiptIsCurrent(
  command: StoredCommand,
  result: StoreCommandResult,
  records: TransitionRecords,
): boolean {
  if (result._tag === 'StoreConflict') return true
  const current = records.connection
  if (
    current === null ||
    current.generation !== result.generation ||
    current.revision !== result.revision
  ) {
    return false
  }
  const operation = current.credentialOperation
  const storedAttempt = records.attempt

  switch (command._tag) {
    case 'InitializeConnection':
      return (
        result._tag === 'ConnectionInitialized' &&
        current.authorization._tag === 'NotAuthorized' &&
        current.authorizationAttemptStateDigest === null &&
        operation === null
      )
    case 'CreateAuthorizationAttempt':
      return (
        result._tag === 'AuthorizationAttemptCreated' &&
        storedAttempt?.state._tag === 'Prepared' &&
        current.authorizationAttemptStateDigest === command.attempt.stateDigest
      )
    case 'AdmitAuthorizationAttempt':
      return (
        result._tag === 'AuthorizationAttemptAdmitted' &&
        storedAttempt?.state._tag === 'Admitted' &&
        admissionMatches(storedAttempt.state.admission, command.admission) &&
        current.authorizationAttemptStateDigest === command.admission.stateDigest &&
        operation !== null &&
        operationMatches(operation, result.operation) &&
        operation.phase._tag === 'OwnedBeforeDispatch' &&
        operation.phase.ownershipFence === command.ownershipFence
      )
    case 'CloseAuthorizationAttempt':
      return (
        result._tag === 'AuthorizationAttemptClosed' &&
        storedAttempt?.state._tag === 'Closed' &&
        storedAttempt.state.reason === 'ProviderDenied' &&
        current.authorizationAttemptStateDigest !== command.stateDigest
      )
    case 'CompleteAuthorizationAttempt':
      return (
        result._tag === 'AuthorizationCompleted' &&
        storedAttempt?.state._tag === 'Closed' &&
        storedAttempt.state.reason === 'Completed' &&
        current.authorization._tag === 'Authorized' &&
        current.authorizationAttemptStateDigest !== command.admission.stateDigest &&
        operation === null
      )
    case 'SaveCredential':
      return (
        result._tag === 'CredentialSaved' &&
        current.authorization._tag === 'Authorized' &&
        current.authorizationAttemptStateDigest === null &&
        operation === null
      )
    case 'AdmitSelfClientExchange':
      return (
        result._tag === 'SelfClientExchangeAdmitted' &&
        operation !== null &&
        operationMatches(operation, result.operation) &&
        operation.kind === 'self-client-exchange' &&
        operation.intent === command.intent &&
        operation.phase._tag === 'OwnedBeforeDispatch' &&
        operation.phase.ownershipFence === command.ownershipFence &&
        operation.phase.leaseExpiresAt > command.acquiredAt
      )
    case 'CompleteSelfClientExchange':
      return (
        result._tag === 'SelfClientExchangeCompleted' &&
        current.authorization._tag === 'Authorized' &&
        operation === null
      )
    case 'AcquireCredentialOperation':
      return (
        result._tag === 'CredentialOperationAcquired' &&
        operation !== null &&
        operationMatches(operation, result.operation) &&
        operation.phase._tag === 'OwnedBeforeDispatch' &&
        operation.phase.ownershipFence === command.ownershipFence &&
        operation.phase.leaseExpiresAt > command.acquiredAt
      )
    case 'ReserveCredentialOperationDispatch':
      return (
        result._tag === 'CredentialOperationDispatchReserved' &&
        operation?.operationId === command.operationId &&
        operation.phase._tag === 'DispatchPossible' &&
        operation.phase.ownershipFence === command.ownershipFence
      )
    case 'CompleteCredentialOperation':
      return (
        result._tag === 'CredentialOperationCompleted' &&
        current.authorization._tag === 'Authorized' &&
        operation === null
      )
    case 'RecordCredentialOperationFailure':
      return (
        result._tag === 'CredentialOperationFailed' &&
        operation?.operationId === command.operationId &&
        operation.phase._tag === 'KnownFailure' &&
        operation.phase.reason === command.reason &&
        operation.phase.recovery === command.recovery
      )
    case 'MarkCredentialOperationIntervention':
      return (
        result._tag === 'CredentialOperationInterventionMarked' &&
        operation?.operationId === command.operationId &&
        operation.phase._tag === 'InterventionRequired' &&
        operation.phase.reason === command.reason
      )
    case 'InvalidateCredential':
      return (
        result._tag === 'CredentialInvalidated' &&
        current.authorization._tag === 'Authorized' &&
        current.authorization.credentialExpiresAt === 0 &&
        operation === null
      )
    case 'RemoveConnection':
      return (
        result._tag === 'ConnectionRemoved' &&
        current.authorization._tag === 'NotAuthorized' &&
        current.authorizationAttemptStateDigest === null &&
        operation === null
      )
  }
}

function replay(command: StoredCommand, records: TransitionRecords): StoreCommandResult | null {
  const receipt = records.receipt
  if (receipt === null) return null
  if (receipt.commandKind !== command._tag || receipt.inputDigest !== command.request.inputDigest) {
    return requestIdReused
  }
  return receiptIsCurrent(command, receipt.result, records) ? receipt.result : conditionChanged
}

function finish(
  command: StoredCommand,
  result: StoreCommandResult,
  writes: Omit<TransitionWrites, 'receipt'> = {},
): StoreTransition {
  return {
    result,
    writes: {
      ...writes,
      receipt: {
        commandKind: command._tag,
        inputDigest: command.request.inputDigest,
        result,
      },
    },
  }
}

function replayed(result: StoreCommandResult): StoreTransition {
  return { result, writes: {} }
}

function validIntent(
  intent: AuthorizationAdmission['intent'],
  current: StoredConnection | null,
): boolean {
  return (
    (intent === 'enroll' && current?.authorization._tag === 'NotAuthorized') ||
    (intent === 'replace' && current?.authorization._tag === 'Authorized')
  )
}

export function transitionStoreCommand(
  command: StoreCommand,
  records: TransitionRecords,
): StoreTransition {
  const receiptResult = replay(command, records)
  if (receiptResult !== null) return replayed(receiptResult)

  const existing = records.connection
  switch (command._tag) {
    case 'InitializeConnection': {
      if (existing !== null) return finish(command, conditionChanged)
      return finish(
        command,
        { _tag: 'ConnectionInitialized', generation: 0, revision: 0 },
        { connection: initialConnection(command.key) },
      )
    }

    case 'CreateAuthorizationAttempt': {
      const candidate = command.attempt
      const current = existing ?? initialConnection(candidate.key)
      const selected = records.selectedAttempt
      if (
        records.attempt !== null ||
        !validIntent(candidate.intent, current) ||
        candidate.generation !== current.generation ||
        (selected !== null && selected.attempt.createdAt > candidate.createdAt) ||
        !Number.isFinite(candidate.createdAt) ||
        !Number.isFinite(candidate.expiresAt) ||
        candidate.expiresAt <= candidate.createdAt ||
        current.credentialOperation?.kind === 'self-client-exchange' ||
        (current.authorizationAttemptStateDigest !== null &&
          (selected === null || selected.state._tag !== 'Prepared'))
      ) {
        return finish(command, conditionChanged)
      }

      const revision =
        current.credentialOperation === null ? current.revision + 1 : current.revision
      const next: StoredConnection = {
        ...current,
        revision,
        authorizationAttemptStateDigest: candidate.stateDigest,
      }
      const attempts: StoredAuthorizationAttempt[] = []
      if (selected !== null) {
        attempts.push({
          ...selected,
          state: { _tag: 'Closed', reason: 'Superseded' },
          closedAt: candidate.createdAt,
        })
      }
      attempts.push({ attempt: candidate, state: { _tag: 'Prepared' }, closedAt: null })
      return finish(
        command,
        {
          _tag: 'AuthorizationAttemptCreated',
          generation: next.generation,
          revision,
        },
        { connection: next, attempts },
      )
    }

    case 'AdmitAuthorizationAttempt': {
      const { admission } = command
      const stored = records.attempt
      const operation = existing?.credentialOperation ?? null
      if (
        stored?.state._tag === 'Admitted' &&
        existing !== null &&
        existing.authorizationAttemptStateDigest === admission.stateDigest &&
        existing.generation === admission.generation &&
        stored.attempt.generation === admission.generation &&
        stored.attempt.intent === admission.intent &&
        stored.state.admission.admissionExpiresAt > admission.admittedAt &&
        operation !== null &&
        operation.kind === 'authorization-exchange' &&
        operation.generation === existing.generation &&
        operation.phase._tag === 'OwnedBeforeDispatch' &&
        operation.phase.leaseExpiresAt <= admission.admittedAt &&
        operation.recoveryDeadline > admission.admittedAt &&
        operation.transferCount < operation.transferLimit &&
        Number.isFinite(admission.admittedAt) &&
        Number.isFinite(admission.admissionExpiresAt) &&
        admission.admissionExpiresAt > admission.admittedAt &&
        Number.isFinite(command.leaseExpiresAt) &&
        command.leaseExpiresAt > admission.admittedAt &&
        command.operation.kind === 'authorization-exchange' &&
        validIntent(admission.intent, existing)
      ) {
        const transferred: CredentialOperation = {
          ...operation,
          transferCount: operation.transferCount + 1,
          phase: {
            _tag: 'OwnedBeforeDispatch',
            ownershipFence: command.ownershipFence,
            leaseExpiresAt: command.leaseExpiresAt,
          },
        }
        const revision = existing.revision + 1
        return finish(
          command,
          {
            _tag: 'AuthorizationAttemptAdmitted',
            generation: existing.generation,
            revision,
            operation: transferred,
          },
          {
            connection: { ...existing, revision, credentialOperation: transferred },
            attempts: [
              {
                ...stored,
                state: { _tag: 'Admitted', admission },
                closedAt: null,
              },
            ],
          },
        )
      }

      if (
        stored === null ||
        existing === null ||
        stored.state._tag !== 'Prepared' ||
        existing.authorizationAttemptStateDigest !== admission.stateDigest ||
        existing.generation !== admission.generation ||
        stored.attempt.generation !== admission.generation ||
        stored.attempt.intent !== admission.intent ||
        stored.attempt.expiresAt <= admission.admittedAt ||
        !Number.isFinite(admission.admittedAt) ||
        !Number.isFinite(admission.admissionExpiresAt) ||
        admission.admissionExpiresAt <= admission.admittedAt ||
        existing.credentialOperation !== null ||
        !validIntent(admission.intent, existing) ||
        command.operation.kind !== 'authorization-exchange' ||
        !Number.isFinite(command.operation.startedAt) ||
        command.operation.startedAt !== admission.admittedAt ||
        !Number.isFinite(command.operation.recoveryDeadline) ||
        command.operation.recoveryDeadline <= admission.admittedAt ||
        !Number.isInteger(command.operation.transferLimit) ||
        command.operation.transferLimit < 0 ||
        !Number.isFinite(command.leaseExpiresAt) ||
        command.leaseExpiresAt <= admission.admittedAt
      ) {
        return finish(command, conditionChanged)
      }

      const credentialOperation: CredentialOperation = {
        schemaVersion: 1,
        operationId: command.operation.operationId,
        kind: 'authorization-exchange',
        generation: existing.generation,
        observedRevision: existing.revision,
        startedAt: command.operation.startedAt,
        recoveryDeadline: command.operation.recoveryDeadline,
        transferCount: 0,
        transferLimit: command.operation.transferLimit,
        phase: {
          _tag: 'OwnedBeforeDispatch',
          ownershipFence: command.ownershipFence,
          leaseExpiresAt: command.leaseExpiresAt,
        },
      }
      const revision = existing.revision + 1
      return finish(
        command,
        {
          _tag: 'AuthorizationAttemptAdmitted',
          generation: existing.generation,
          revision,
          operation: credentialOperation,
        },
        {
          connection: { ...existing, revision, credentialOperation },
          attempts: [
            {
              ...stored,
              state: { _tag: 'Admitted', admission },
              closedAt: null,
            },
          ],
        },
      )
    }

    case 'CloseAuthorizationAttempt': {
      const stored = records.attempt
      if (
        existing === null ||
        stored === null ||
        stored.state._tag !== 'Prepared' ||
        existing.authorizationAttemptStateDigest !== command.stateDigest ||
        existing.generation !== command.expectedGeneration ||
        stored.attempt.generation !== command.expectedGeneration ||
        stored.attempt.expiresAt <= command.closedAt ||
        !Number.isFinite(command.closedAt)
      ) {
        return finish(command, conditionChanged)
      }
      const revision =
        existing.credentialOperation === null ? existing.revision + 1 : existing.revision
      return finish(
        command,
        {
          _tag: 'AuthorizationAttemptClosed',
          generation: existing.generation,
          revision,
        },
        {
          connection: {
            ...existing,
            revision,
            authorizationAttemptStateDigest: null,
          },
          attempts: [
            {
              ...stored,
              state: { _tag: 'Closed', reason: command.reason },
              closedAt: command.closedAt,
            },
          ],
        },
      )
    }

    case 'CompleteAuthorizationAttempt': {
      const stored = records.attempt
      const operation = existing?.credentialOperation ?? null
      if (
        existing === null ||
        stored === null ||
        stored.state._tag !== 'Admitted' ||
        !admissionMatches(stored.state.admission, command.admission) ||
        existing.authorizationAttemptStateDigest !== command.admission.stateDigest ||
        existing.generation !== command.admission.generation ||
        existing.revision !== command.expectedRevision ||
        operation === null ||
        operation.kind !== 'authorization-exchange' ||
        operation.operationId !== command.operationId ||
        operation.phase._tag !== 'DispatchPossible' ||
        operation.phase.ownershipFence !== command.ownershipFence ||
        !validIntent(command.admission.intent, existing) ||
        !Number.isFinite(command.completedAt) ||
        (command.credentialExpiresAt !== null && !Number.isFinite(command.credentialExpiresAt))
      ) {
        return finish(command, conditionChanged)
      }
      const generation =
        command.admission.intent === 'replace' ? existing.generation + 1 : existing.generation
      const revision = existing.revision + 1
      return finish(
        command,
        { _tag: 'AuthorizationCompleted', generation, revision },
        {
          connection: {
            ...existing,
            generation,
            revision,
            authorization: {
              _tag: 'Authorized',
              credentialExpiresAt: command.credentialExpiresAt,
              credentialAcquiredAt: null,
            },
            credentialEnvelope: command.credentialEnvelope,
            credentialOperation: null,
            authorizationAttemptStateDigest: null,
          },
          attempts: [
            {
              ...stored,
              state: { _tag: 'Closed', reason: 'Completed' },
              closedAt: command.completedAt,
            },
          ],
        },
      )
    }
  }
}

export function transitionCredentialOperation(
  command: CredentialOperationCommand,
  records: TransitionRecords,
): StoreTransition {
  const receiptResult = replay(command, records)
  if (receiptResult !== null) return replayed(receiptResult)

  const existing = records.connection
  const operation = existing?.credentialOperation ?? null
  switch (command._tag) {
    case 'AdmitSelfClientExchange': {
      const current = existing ?? initialConnection(command.key)
      const priorOperation = current.credentialOperation
      const canSupersedePrior =
        priorOperation === null ||
        (priorOperation.kind === 'self-client-exchange' &&
          priorOperation.intent === command.intent &&
          (priorOperation.phase._tag === 'KnownFailure' ||
            priorOperation.phase._tag === 'InterventionRequired' ||
            (priorOperation.phase._tag === 'OwnedBeforeDispatch' &&
              priorOperation.phase.leaseExpiresAt <= command.acquiredAt)))
      if (
        current.generation !== command.expectedGeneration ||
        current.revision !== command.expectedRevision ||
        current.authorizationAttemptStateDigest !== null ||
        !validIntent(command.intent, current) ||
        !canSupersedePrior ||
        !Number.isFinite(command.acquiredAt) ||
        !Number.isFinite(command.leaseExpiresAt) ||
        command.leaseExpiresAt <= command.acquiredAt ||
        !Number.isFinite(command.proposal.startedAt) ||
        command.proposal.startedAt !== command.acquiredAt ||
        !Number.isFinite(command.proposal.recoveryDeadline) ||
        command.proposal.recoveryDeadline <= command.acquiredAt ||
        !Number.isInteger(command.proposal.transferLimit) ||
        command.proposal.transferLimit < 0
      ) {
        return finish(command, conditionChanged)
      }

      const credentialOperation: SelfClientExchangeOperation = {
        schemaVersion: 1,
        operationId: command.proposal.operationId,
        kind: 'self-client-exchange',
        intent: command.intent,
        generation: current.generation,
        observedRevision: current.revision,
        startedAt: command.proposal.startedAt,
        recoveryDeadline: command.proposal.recoveryDeadline,
        transferCount: 0,
        transferLimit: command.proposal.transferLimit,
        phase: {
          _tag: 'OwnedBeforeDispatch',
          ownershipFence: command.ownershipFence,
          leaseExpiresAt: command.leaseExpiresAt,
        },
      }
      const revision = current.revision + 1
      return finish(
        command,
        {
          _tag: 'SelfClientExchangeAdmitted',
          generation: current.generation,
          revision,
          operation: credentialOperation,
        },
        { connection: { ...current, revision, credentialOperation } },
      )
    }

    case 'CompleteSelfClientExchange': {
      if (
        existing === null ||
        operation?.kind !== 'self-client-exchange' ||
        existing.generation !== command.expectedGeneration ||
        existing.revision !== command.expectedRevision ||
        operation.operationId !== command.operationId ||
        operation.generation !== command.expectedGeneration ||
        operation.phase._tag !== 'DispatchPossible' ||
        operation.phase.ownershipFence !== command.ownershipFence ||
        !validIntent(operation.intent, existing) ||
        !Number.isFinite(command.completedAt) ||
        (command.credentialExpiresAt !== null && !Number.isFinite(command.credentialExpiresAt))
      ) {
        return finish(command, conditionChanged)
      }
      const generation =
        operation.intent === 'replace' ? existing.generation + 1 : existing.generation
      const revision = existing.revision + 1
      return finish(
        command,
        { _tag: 'SelfClientExchangeCompleted', generation, revision },
        {
          connection: {
            ...existing,
            generation,
            revision,
            authorization: {
              _tag: 'Authorized',
              credentialExpiresAt: command.credentialExpiresAt,
              credentialAcquiredAt: null,
            },
            credentialEnvelope: command.credentialEnvelope,
            credentialOperation: null,
            authorizationAttemptStateDigest: null,
          },
        },
      )
    }

    case 'SaveCredential': {
      const current = existing ?? initialConnection(command.key)
      if (
        current.generation !== command.expectedGeneration ||
        current.revision !== command.expectedRevision ||
        current.authorizationAttemptStateDigest !== null ||
        !validIntent(command.intent, current) ||
        (current.credentialOperation !== null &&
          (command.intent !== 'replace' ||
            current.credentialOperation.kind === 'self-client-exchange')) ||
        (command.credentialExpiresAt !== null && !Number.isFinite(command.credentialExpiresAt)) ||
        (command.credentialAcquiredAt !== null &&
          command.credentialAcquiredAt !== undefined &&
          !Number.isFinite(command.credentialAcquiredAt))
      ) {
        return finish(command, conditionChanged)
      }
      const generation = command.intent === 'replace' ? current.generation + 1 : current.generation
      const revision = current.revision + 1
      return finish(
        command,
        { _tag: 'CredentialSaved', generation, revision },
        {
          connection: {
            ...current,
            generation,
            revision,
            authorization: {
              _tag: 'Authorized',
              credentialExpiresAt: command.credentialExpiresAt,
              credentialAcquiredAt: command.credentialAcquiredAt ?? null,
            },
            credentialEnvelope: command.credentialEnvelope,
            credentialOperation: null,
            authorizationAttemptStateDigest: null,
          },
        },
      )
    }

    case 'AcquireCredentialOperation': {
      if (
        existing === null ||
        existing.authorization._tag !== 'Authorized' ||
        existing.generation !== command.expectedGeneration ||
        existing.revision !== command.expectedRevision ||
        !Number.isFinite(command.acquiredAt) ||
        !Number.isFinite(command.leaseExpiresAt) ||
        command.leaseExpiresAt <= command.acquiredAt
      ) {
        return finish(command, conditionChanged)
      }

      const recoverableFailure =
        operation?.phase._tag === 'KnownFailure' &&
        operation.phase.reason === 'ProviderFailure' &&
        operation.phase.recovery === 'NotDispatched' &&
        operation.kind === command.proposal.kind &&
        operation.generation === existing.generation
      let acquired: CredentialOperation
      if (operation === null || recoverableFailure) {
        if (
          (command.proposal.kind !== 'refresh' &&
            command.proposal.kind !== 'client-credentials-acquisition') ||
          !Number.isFinite(command.proposal.startedAt) ||
          command.proposal.startedAt !== command.acquiredAt ||
          !Number.isFinite(command.proposal.recoveryDeadline) ||
          command.proposal.recoveryDeadline <= command.acquiredAt ||
          !Number.isInteger(command.proposal.transferLimit) ||
          command.proposal.transferLimit < 0
        ) {
          return finish(command, conditionChanged)
        }
        acquired = {
          schemaVersion: 1,
          operationId: command.proposal.operationId,
          kind: command.proposal.kind,
          generation: existing.generation,
          observedRevision: existing.revision,
          startedAt: command.proposal.startedAt,
          recoveryDeadline: command.proposal.recoveryDeadline,
          transferCount: 0,
          transferLimit: command.proposal.transferLimit,
          phase: {
            _tag: 'OwnedBeforeDispatch',
            ownershipFence: command.ownershipFence,
            leaseExpiresAt: command.leaseExpiresAt,
          },
        }
      } else {
        if (
          operation.generation !== existing.generation ||
          operation.kind !== command.proposal.kind ||
          operation.phase._tag !== 'OwnedBeforeDispatch' ||
          operation.phase.leaseExpiresAt > command.acquiredAt ||
          operation.recoveryDeadline <= command.acquiredAt ||
          operation.transferCount >= operation.transferLimit
        ) {
          return finish(command, conditionChanged)
        }
        acquired = {
          ...operation,
          transferCount: operation.transferCount + 1,
          phase: {
            _tag: 'OwnedBeforeDispatch',
            ownershipFence: command.ownershipFence,
            leaseExpiresAt: command.leaseExpiresAt,
          },
        }
      }

      const revision = existing.revision + 1
      return finish(
        command,
        {
          _tag: 'CredentialOperationAcquired',
          generation: existing.generation,
          revision,
          operation: acquired,
        },
        { connection: { ...existing, revision, credentialOperation: acquired } },
      )
    }

    case 'ReserveCredentialOperationDispatch': {
      if (
        existing === null ||
        operation === null ||
        existing.generation !== command.expectedGeneration ||
        existing.revision !== command.expectedRevision ||
        operation.operationId !== command.operationId ||
        operation.generation !== command.expectedGeneration ||
        operation.phase._tag !== 'OwnedBeforeDispatch' ||
        operation.phase.ownershipFence !== command.ownershipFence ||
        operation.phase.leaseExpiresAt <= command.reservedAt ||
        operation.recoveryDeadline <= command.reservedAt ||
        !Number.isFinite(command.reservedAt)
      ) {
        return finish(command, conditionChanged)
      }
      const revision = existing.revision + 1
      return finish(
        command,
        {
          _tag: 'CredentialOperationDispatchReserved',
          generation: existing.generation,
          revision,
        },
        {
          connection: {
            ...existing,
            revision,
            credentialOperation: {
              ...operation,
              phase: {
                _tag: 'DispatchPossible',
                ownershipFence: command.ownershipFence,
                leaseExpiresAt: operation.phase.leaseExpiresAt,
                reservedAt: command.reservedAt,
              },
            },
          },
        },
      )
    }

    case 'CompleteCredentialOperation': {
      if (
        existing === null ||
        operation === null ||
        existing.generation !== command.expectedGeneration ||
        existing.revision !== command.expectedRevision ||
        operation.operationId !== command.operationId ||
        (operation.kind !== 'refresh' && operation.kind !== 'client-credentials-acquisition') ||
        operation.generation !== command.expectedGeneration ||
        operation.phase._tag !== 'DispatchPossible' ||
        operation.phase.ownershipFence !== command.ownershipFence ||
        !Number.isFinite(command.completedAt) ||
        (command.credentialExpiresAt !== null && !Number.isFinite(command.credentialExpiresAt)) ||
        (command.credentialAcquiredAt !== null &&
          command.credentialAcquiredAt !== undefined &&
          !Number.isFinite(command.credentialAcquiredAt))
      ) {
        return finish(command, conditionChanged)
      }
      const revision = existing.revision + 1
      return finish(
        command,
        {
          _tag: 'CredentialOperationCompleted',
          generation: existing.generation,
          revision,
        },
        {
          connection: {
            ...existing,
            revision,
            authorization: {
              _tag: 'Authorized',
              credentialExpiresAt: command.credentialExpiresAt,
              credentialAcquiredAt: command.credentialAcquiredAt ?? null,
            },
            credentialEnvelope: command.credentialEnvelope,
            credentialOperation: null,
          },
        },
      )
    }

    case 'RecordCredentialOperationFailure': {
      if (
        existing === null ||
        operation === null ||
        existing.generation !== command.expectedGeneration ||
        existing.revision !== command.expectedRevision ||
        operation.operationId !== command.operationId ||
        operation.phase._tag !== 'DispatchPossible' ||
        operation.phase.ownershipFence !== command.ownershipFence ||
        !Number.isFinite(command.failedAt) ||
        (command.recovery !== undefined &&
          (command.recovery !== 'NotDispatched' ||
            command.reason !== 'ProviderFailure' ||
            (operation.kind !== 'refresh' && operation.kind !== 'client-credentials-acquisition')))
      ) {
        return finish(command, conditionChanged)
      }
      const revision = existing.revision + 1
      return finish(
        command,
        {
          _tag: 'CredentialOperationFailed',
          generation: existing.generation,
          revision,
          reason: command.reason,
        },
        {
          connection: {
            ...existing,
            revision,
            credentialOperation: {
              ...operation,
              phase: {
                _tag: 'KnownFailure',
                reason: command.reason,
                failedAt: command.failedAt,
                ...(command.recovery === undefined ? {} : { recovery: command.recovery }),
              },
            },
          },
        },
      )
    }

    case 'MarkCredentialOperationIntervention': {
      const fromCurrentUnknown =
        operation?.phase._tag === 'DispatchPossible' &&
        (command.reason === 'ProviderOutcomeUnknown' ||
          command.reason === 'KnownResponseNotPersisted') &&
        operation.phase.ownershipFence === command.ownershipFence
      const fromExpiredDispatch =
        operation?.phase._tag === 'DispatchPossible' &&
        command.reason === 'DispatchOwnerExpired' &&
        operation.phase.leaseExpiresAt <= command.markedAt
      const fromExhaustedRecovery =
        operation?.phase._tag === 'OwnedBeforeDispatch' &&
        command.reason === 'RecoveryLimitExceeded' &&
        (operation.recoveryDeadline <= command.markedAt ||
          operation.transferCount >= operation.transferLimit)
      if (
        existing === null ||
        operation === null ||
        existing.generation !== command.expectedGeneration ||
        existing.revision !== command.expectedRevision ||
        operation.operationId !== command.operationId ||
        (!fromCurrentUnknown && !fromExpiredDispatch && !fromExhaustedRecovery) ||
        !Number.isFinite(command.markedAt)
      ) {
        return finish(command, conditionChanged)
      }
      const revision = existing.revision + 1
      return finish(
        command,
        {
          _tag: 'CredentialOperationInterventionMarked',
          generation: existing.generation,
          revision,
        },
        {
          connection: {
            ...existing,
            revision,
            credentialOperation: {
              ...operation,
              phase: {
                _tag: 'InterventionRequired',
                reason: command.reason,
                markedAt: command.markedAt,
              },
            },
          },
        },
      )
    }

    case 'InvalidateCredential': {
      if (
        existing === null ||
        existing.authorization._tag !== 'Authorized' ||
        existing.credentialEnvelope === null
      ) {
        return finish(command, conditionChanged)
      }
      if (
        existing.credentialOperation !== null ||
        existing.generation !== command.expectedGeneration ||
        existing.revision !== command.expectedRevision
      ) {
        return finish(command, conditionChanged)
      }
      const revision = existing.revision + 1
      const invalidated: StoredConnection = {
        schemaVersion: existing.schemaVersion,
        key: existing.key,
        generation: existing.generation,
        revision,
        credentialOperation: existing.credentialOperation,
        authorizationAttemptStateDigest: existing.authorizationAttemptStateDigest,
        authorization: {
          _tag: 'Authorized',
          credentialExpiresAt: 0,
          credentialAcquiredAt: existing.authorization.credentialAcquiredAt,
        },
        credentialEnvelope: existing.credentialEnvelope,
      }
      return finish(
        command,
        { _tag: 'CredentialInvalidated', generation: existing.generation, revision },
        { connection: invalidated },
      )
    }

    case 'RemoveConnection': {
      if (
        existing === null ||
        existing.generation !== command.expectedGeneration ||
        existing.revision !== command.expectedRevision ||
        !Number.isFinite(command.removedAt)
      ) {
        return finish(command, conditionChanged)
      }
      if (
        existing.authorization._tag === 'NotAuthorized' &&
        existing.credentialOperation === null &&
        existing.authorizationAttemptStateDigest === null
      ) {
        return finish(command, {
          _tag: 'ConnectionRemoved',
          generation: existing.generation,
          revision: existing.revision,
        })
      }
      const generation = existing.generation + 1
      const revision = existing.revision + 1
      return finish(
        command,
        { _tag: 'ConnectionRemoved', generation, revision },
        {
          connection: {
            ...existing,
            generation,
            revision,
            authorization: { _tag: 'NotAuthorized' },
            credentialEnvelope: null,
            credentialOperation: null,
            authorizationAttemptStateDigest: null,
          },
        },
      )
    }
  }
}

export function projectConnection(stored: StoredConnection | null): ConnectionSnapshot | null {
  if (stored === null) return null
  const { authorizationAttemptStateDigest: _authorizationAttemptStateDigest, ...connection } =
    stored
  return connection
}

export function projectConnectionInspection(
  stored: StoredConnection | null,
): StoredConnectionInspection | null {
  if (stored === null) return null
  return {
    schemaVersion: 1,
    key: stored.key,
    savedAuthorization: stored.authorization._tag === 'Authorized',
    credentialWork:
      stored.credentialOperation === null
        ? 'idle'
        : stored.credentialOperation.phase._tag === 'InterventionRequired'
          ? 'intervention-required'
          : stored.credentialOperation.phase._tag === 'KnownFailure'
            ? 'known-failure'
            : 'pending',
  }
}

export function projectAuthorizationAttempt(
  stored: StoredAuthorizationAttempt | null,
  current: StoredConnection | null,
  lookup: AuthorizationAttemptLookup,
): AuthorizationAttempt | null {
  if (stored === null || current === null) return null
  const candidate = stored.attempt
  const operation = current.credentialOperation
  const isReadable =
    (stored.state._tag === 'Prepared' && candidate.expiresAt > lookup.now) ||
    (stored.state._tag === 'Admitted' &&
      stored.state.admission.admissionExpiresAt > lookup.now &&
      operation?.kind === 'authorization-exchange' &&
      operation.generation === current.generation &&
      operation.phase._tag === 'OwnedBeforeDispatch' &&
      operation.phase.leaseExpiresAt <= lookup.now &&
      operation.recoveryDeadline > lookup.now &&
      operation.transferCount < operation.transferLimit)
  return isReadable &&
    candidate.key.namespace === lookup.namespace &&
    candidate.stateDigest === lookup.stateDigest &&
    candidate.bindingDigest === lookup.bindingDigest &&
    current.generation === candidate.generation &&
    current.authorizationAttemptStateDigest === candidate.stateDigest
    ? candidate
    : null
}
