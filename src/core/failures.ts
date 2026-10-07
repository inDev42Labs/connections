import { Data } from 'effect'

export class ProviderRejectedCause extends Data.TaggedClass('ProviderRejected')<{}> {}

export class ProviderFailureCause extends Data.TaggedClass('ProviderFailure')<{}> {}

export class ProviderOutcomeUnknownCause extends Data.TaggedClass('ProviderOutcomeUnknown')<{}> {}

export class StorageFailureCause extends Data.TaggedClass('StorageFailure')<{}> {}

export class EncryptionFailureCause extends Data.TaggedClass('EncryptionFailure')<{}> {}

export class ConflictCause extends Data.TaggedClass('Conflict')<{}> {}

export type SafeCredentialCause =
  | ProviderRejectedCause
  | ProviderFailureCause
  | ProviderOutcomeUnknownCause
  | StorageFailureCause
  | EncryptionFailureCause
  | ConflictCause

export type InterventionCause = ProviderOutcomeUnknownCause | EncryptionFailureCause | ConflictCause

export type OperationalCause =
  | ProviderRejectedCause
  | ProviderFailureCause
  | StorageFailureCause
  | EncryptionFailureCause
  | ConflictCause

export class AuthorizationRequired extends Data.TaggedError('AuthorizationRequired')<{}> {}

export class TemporarilyUnavailable extends Data.TaggedError('TemporarilyUnavailable')<{
  readonly cause?: ProviderFailureCause | StorageFailureCause
}> {}

export class InterventionRequired extends Data.TaggedError('InterventionRequired')<{
  readonly cause: InterventionCause
}> {}

export type CredentialFailure =
  | AuthorizationRequired
  | TemporarilyUnavailable
  | InterventionRequired

export class CredentialRejectionFailure extends Data.TaggedError('CredentialRejectionFailure')<{
  readonly reason: 'StorageFailure' | 'Conflict'
}> {}

export class AuthorizationFailure extends Data.TaggedError('AuthorizationFailure')<{
  readonly reason:
    | 'InvalidCallback'
    | 'InvalidAttempt'
    | 'ProviderDenied'
    | 'Pending'
    | 'InterventionRequired'
    | 'Conflict'
    | 'ProviderRejected'
    | 'ProviderFailure'
    | 'StorageFailure'
    | 'EncryptionFailure'
}> {}

export class CredentialConfigurationFailure extends Data.TaggedError(
  'CredentialConfigurationFailure',
)<{
  readonly reason:
    | 'InvalidApiKey'
    | 'InvalidCredentials'
    | 'StorageFailure'
    | 'EncryptionFailure'
    | 'Conflict'
}> {}

export class InspectionFailure extends Data.TaggedError('InspectionFailure')<{
  readonly reason: 'StorageFailure'
}> {}

export class RemovalFailure extends Data.TaggedError('RemovalFailure')<{
  readonly reason: 'StorageFailure' | 'Conflict'
}> {}
