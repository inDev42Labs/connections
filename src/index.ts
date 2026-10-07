export {
  AuthorizationFailure,
  AuthorizationRequired,
  CredentialConfigurationFailure,
  CredentialRejectionFailure,
  InspectionFailure,
  InterventionRequired,
  TemporarilyUnavailable,
  RemovalFailure,
} from './core/failures.js'
export type { InterventionCause, OperationalCause, SafeCredentialCause } from './core/failures.js'
export type {
  AuthorizationStart,
  AuthorizationTarget,
  ConnectionInspection,
  CredentialWorkCondition,
  CredentialUse,
} from './core/manager.js'

import { makeManager } from './core/manager.js'
export { revealSecret } from './core/manager.js'
export type {
  PromiseCredentialUse,
  PromiseReadManager,
  PromiseApiKeyManager,
  PromiseClientCredentialsManager,
  PromiseOAuthManager,
  PromiseSelfClientManager,
  AuthorizationOptions,
  CompleteAuthorizationOptions,
  EnrollCodeOptions,
  ReplaceOptions,
  ReadCredentialFailure,
} from './core/manager.js'

export const Connections = { create: makeManager } as const
