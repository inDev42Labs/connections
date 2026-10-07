import { AuthorizationFailure } from '../../src/index.js'
import type { ReadCredentialFailure, RemovalFailure, SafeCredentialCause } from '../../src/index.js'

export const processCheckpoints = [
  'pre-dispatch',
  'dispatch-possible',
  'response-received',
  'completion-acknowledgement',
  'replacement-response-received',
  'self-client-response-received',
  'removal-acknowledgement',
] as const

export type ProcessCheckpoint = (typeof processCheckpoints)[number]

export const credentialOutcomeTags = [
  'AuthorizationRequired',
  'TemporarilyUnavailable',
  'InterventionRequired',
] as const

export type CredentialOutcomeTag = (typeof credentialOutcomeTags)[number]

export const safeCredentialCauseTags = [
  'ProviderRejected',
  'ProviderFailure',
  'ProviderOutcomeUnknown',
  'StorageFailure',
  'EncryptionFailure',
  'Conflict',
] as const

export type SafeCredentialCauseTag = (typeof safeCredentialCauseTags)[number]

export type InterventionCauseTag = 'ProviderOutcomeUnknown' | 'EncryptionFailure' | 'Conflict'

export type OperationalCauseTag =
  | 'ProviderRejected'
  | 'ProviderFailure'
  | 'StorageFailure'
  | 'EncryptionFailure'
  | 'Conflict'

type SerializedSafeCredentialCause<Tag extends SafeCredentialCauseTag> = {
  readonly _tag: Tag
}

export type SerializedCredentialFailure =
  | { readonly _tag: 'AuthorizationRequired' }
  | {
      readonly _tag: 'InterventionRequired'
      readonly cause: SerializedSafeCredentialCause<InterventionCauseTag>
    }
  | {
      readonly _tag: 'TemporarilyUnavailable'
      readonly cause?: SerializedSafeCredentialCause<'ProviderFailure' | 'StorageFailure'>
    }

type AuthorizationFailureReason = AuthorizationFailure['reason']
type RemovalFailureReason = RemovalFailure['reason']

export type WorkerEvidence =
  | { readonly checkpoint: ProcessCheckpoint; readonly pid: number }
  | {
      readonly outcome: 'credentials'
      readonly accessToken: string
      readonly pid: number
    }
  | { readonly outcome: 'authorization-start'; readonly state: string; readonly pid: number }
  | {
      readonly outcome: 'authorization-completed'
      readonly connectionId: string
      readonly pid: number
    }
  | { readonly outcome: 'self-client-enrolled'; readonly approved: true; readonly pid: number }
  | { readonly outcome: 'removed'; readonly pid: number }
  | {
      readonly outcome: 'credential-failure'
      readonly failure: SerializedCredentialFailure
      readonly pid: number
    }
  | {
      readonly outcome: 'authorization-failure'
      readonly reason: AuthorizationFailureReason
      readonly pid: number
    }
  | {
      readonly outcome: 'removal-failure'
      readonly reason: RemovalFailureReason
      readonly pid: number
    }

function unreachable(_value: never): never {
  throw new Error('Unsupported process worker evidence')
}

function serializeSafeCredentialCause<Cause extends SafeCredentialCause>(
  cause: Cause,
): SerializedSafeCredentialCause<Cause['_tag']> {
  switch (cause._tag) {
    case 'ProviderRejected':
    case 'ProviderFailure':
    case 'ProviderOutcomeUnknown':
    case 'StorageFailure':
    case 'EncryptionFailure':
    case 'Conflict':
      return { _tag: cause._tag }
    default:
      return unreachable(cause)
  }
}

export function serializeCredentialFailure(
  failure: ReadCredentialFailure,
): SerializedCredentialFailure {
  switch (failure._tag) {
    case 'AuthorizationRequired':
      return { _tag: failure._tag }
    case 'InterventionRequired':
      return {
        _tag: failure._tag,
        cause: serializeSafeCredentialCause(failure.cause),
      }
    case 'TemporarilyUnavailable':
      return failure.cause === undefined
        ? { _tag: failure._tag }
        : { _tag: failure._tag, cause: serializeSafeCredentialCause(failure.cause) }
    default:
      return unreachable(failure)
  }
}

export function serializeAuthorizationFailure(failure: unknown): AuthorizationFailureReason {
  if (!(failure instanceof AuthorizationFailure)) throw failure
  switch (failure.reason) {
    case 'InvalidCallback':
    case 'InvalidAttempt':
    case 'ProviderDenied':
    case 'Pending':
    case 'InterventionRequired':
    case 'Conflict':
    case 'ProviderRejected':
    case 'ProviderFailure':
    case 'StorageFailure':
    case 'EncryptionFailure':
      return failure.reason
    default:
      return unreachable(failure.reason)
  }
}

export function serializeRemovalFailure(failure: RemovalFailure): RemovalFailureReason {
  switch (failure.reason) {
    case 'StorageFailure':
    case 'Conflict':
      return failure.reason
    default:
      return unreachable(failure.reason)
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function hasExactKeys(value: Record<string, unknown>, keys: ReadonlyArray<string>): boolean {
  const actual = Object.keys(value).sort()
  const expected = [...keys].sort()
  return actual.length === expected.length && actual.every((key, index) => key === expected[index])
}

function isPid(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0
}

function isStringMember<const Values extends ReadonlyArray<string>>(
  values: Values,
  value: unknown,
): value is Values[number] {
  return typeof value === 'string' && values.some((candidate) => candidate === value)
}

function parseSafeCredentialCause(
  value: unknown,
): SerializedSafeCredentialCause<SafeCredentialCauseTag> | undefined {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ['_tag']) ||
    !isStringMember(safeCredentialCauseTags, value._tag)
  ) {
    return undefined
  }
  return { _tag: value._tag }
}

function parseCredentialFailure(value: unknown): SerializedCredentialFailure | undefined {
  if (!isRecord(value) || !isStringMember(credentialOutcomeTags, value._tag)) return undefined

  switch (value._tag) {
    case 'AuthorizationRequired':
      return hasExactKeys(value, ['_tag']) ? { _tag: value._tag } : undefined
    case 'InterventionRequired': {
      if (!hasExactKeys(value, ['_tag', 'cause'])) return undefined
      const cause = parseSafeCredentialCause(value.cause)
      return cause === undefined ||
        (cause._tag !== 'ProviderOutcomeUnknown' &&
          cause._tag !== 'EncryptionFailure' &&
          cause._tag !== 'Conflict')
        ? undefined
        : { _tag: value._tag, cause: { _tag: cause._tag } }
    }
    case 'TemporarilyUnavailable': {
      if (hasExactKeys(value, ['_tag'])) return { _tag: value._tag }
      if (!hasExactKeys(value, ['_tag', 'cause'])) return undefined
      const cause = parseSafeCredentialCause(value.cause)
      return cause === undefined ||
        (cause._tag !== 'ProviderFailure' && cause._tag !== 'StorageFailure')
        ? undefined
        : { _tag: value._tag, cause: { _tag: cause._tag } }
    }
  }
}

const authorizationFailureReasons = [
  'InvalidCallback',
  'InvalidAttempt',
  'ProviderDenied',
  'Pending',
  'InterventionRequired',
  'Conflict',
  'ProviderRejected',
  'ProviderFailure',
  'StorageFailure',
  'EncryptionFailure',
] as const satisfies ReadonlyArray<AuthorizationFailureReason>

const removalFailureReasons = [
  'StorageFailure',
  'Conflict',
] as const satisfies ReadonlyArray<RemovalFailureReason>

export function parseWorkerEvidence(value: unknown): WorkerEvidence | undefined {
  if (!isRecord(value) || !isPid(value.pid)) return undefined

  if (
    hasExactKeys(value, ['checkpoint', 'pid']) &&
    isStringMember(processCheckpoints, value.checkpoint)
  ) {
    return { checkpoint: value.checkpoint, pid: value.pid }
  }

  if (typeof value.outcome !== 'string') return undefined
  switch (value.outcome) {
    case 'credentials':
      return hasExactKeys(value, ['accessToken', 'outcome', 'pid']) &&
        typeof value.accessToken === 'string'
        ? { outcome: value.outcome, accessToken: value.accessToken, pid: value.pid }
        : undefined
    case 'authorization-start':
      return hasExactKeys(value, ['outcome', 'pid', 'state']) && typeof value.state === 'string'
        ? { outcome: value.outcome, state: value.state, pid: value.pid }
        : undefined
    case 'authorization-completed':
      return hasExactKeys(value, ['connectionId', 'outcome', 'pid']) &&
        typeof value.connectionId === 'string'
        ? { outcome: value.outcome, connectionId: value.connectionId, pid: value.pid }
        : undefined
    case 'self-client-enrolled':
      return hasExactKeys(value, ['approved', 'outcome', 'pid']) && value.approved === true
        ? { outcome: value.outcome, approved: true, pid: value.pid }
        : undefined
    case 'removed':
      return hasExactKeys(value, ['outcome', 'pid'])
        ? { outcome: value.outcome, pid: value.pid }
        : undefined
    case 'credential-failure': {
      if (!hasExactKeys(value, ['failure', 'outcome', 'pid'])) return undefined
      const failure = parseCredentialFailure(value.failure)
      return failure === undefined ? undefined : { outcome: value.outcome, failure, pid: value.pid }
    }
    case 'authorization-failure':
      return hasExactKeys(value, ['outcome', 'pid', 'reason']) &&
        isStringMember(authorizationFailureReasons, value.reason)
        ? { outcome: value.outcome, reason: value.reason, pid: value.pid }
        : undefined
    case 'removal-failure':
      return hasExactKeys(value, ['outcome', 'pid', 'reason']) &&
        isStringMember(removalFailureReasons, value.reason)
        ? { outcome: value.outcome, reason: value.reason, pid: value.pid }
        : undefined
    default:
      return undefined
  }
}
