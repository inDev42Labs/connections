import type { Effect, Redacted } from 'effect'
import type { AuthorizationIntent, CredentialIntent } from './contracts/store.js'
import type { CredentialRejectionFailure } from './failures.js'

export interface ConnectionIdentity {
  readonly namespace: string
  readonly providerId: string
  readonly connectionId: string
}

export interface AuthorizationStartInput {
  readonly binding: string
  readonly intent: AuthorizationIntent
}

export interface SetApiKeyInput {
  readonly apiKey: Redacted.Redacted<string>
  readonly intent: CredentialIntent
}

export interface SetClientCredentialsInput<SourceCredentials> {
  readonly credentials: SourceCredentials
  readonly intent: CredentialIntent
}

export interface CredentialUse<Credentials, Requirements = never> {
  readonly credentials: Credentials
  readonly reportRejected: () => Effect.Effect<void, CredentialRejectionFailure, Requirements>
}

export type CredentialWorkCondition = 'idle' | 'pending' | 'intervention-required' | 'known-failure'

export interface ConnectionInspection {
  readonly savedAuthorization: boolean
  readonly credentialWork: CredentialWorkCondition
}

export interface AuthorizationStart {
  readonly url: string
  readonly expiresAt: number
}

export function credentialIsLocallyUsable(
  credentialExpiresAt: number | null,
  now: number,
): boolean {
  return credentialExpiresAt === null || credentialExpiresAt > now
}

export interface AuthorizationTarget {
  readonly connectionId: string
  readonly intent: AuthorizationIntent
}

export interface CompleteAuthorizationInput<AuthorizeError, AuthorizeRequirements> {
  readonly callbackUrl: string
  readonly binding: string
  readonly authorize: (
    target: AuthorizationTarget,
  ) => Effect.Effect<void, AuthorizeError, AuthorizeRequirements>
}

export interface SelfClientEnrollmentInput<AuthorizeError, AuthorizeRequirements> {
  readonly code: Redacted.Redacted<string>
  readonly intent: CredentialIntent
  readonly authorize: () => Effect.Effect<void, AuthorizeError, AuthorizeRequirements>
}
