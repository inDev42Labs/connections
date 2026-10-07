import type { Effect, Redacted } from 'effect'
import type { CredentialFailureRecovery } from './recovery.js'

const providerCredentialsType: unique symbol = Symbol.for(
  '@indev42/connections/providerCredentials',
)

export interface AuthorizationUrlInput {
  readonly state: string
  readonly codeChallenge: string
}

export type AuthorizationCallback =
  | {
      readonly _tag: 'AuthorizationGranted'
      readonly state: string
      readonly code: Redacted.Redacted<string>
    }
  | {
      readonly _tag: 'AuthorizationDenied'
      readonly state: string
    }

export interface AuthorizationCodeExchangeInput {
  readonly code: Redacted.Redacted<string>
  readonly codeVerifier: Redacted.Redacted<string>
  readonly now: number
}

export interface ProviderCredentialSet {
  readonly protectedPayload: Redacted.Redacted<string>
  readonly credentialExpiresAt: number | null
}

export interface ProviderAuthorizationFailure {
  readonly reason:
    | 'ProviderRejected'
    | 'TransportFailure'
    | 'MalformedResponse'
    | 'InvalidConfiguration'
    | 'InvalidCallback'
    | 'InvalidStoredCredentials'
}

export interface RefreshCredentialInput {
  readonly protectedPayload: Redacted.Redacted<string>
  readonly now: number
  readonly deadline?: number
  readonly replayUntil?: number
}

export type ProviderRefreshOutcome =
  | {
      readonly _tag: 'Refreshed'
      readonly credentials: ProviderCredentialSet
    }
  | { readonly _tag: 'ProviderRejected' }
  | { readonly _tag: 'ProviderFailure'; readonly recovery?: CredentialFailureRecovery }
  | { readonly _tag: 'ProviderOutcomeUnknown' }

export interface PreparedClientCredentials {
  readonly protectedPayload: Redacted.Redacted<string>
}

export interface ClientCredentialsAcquisitionInput {
  readonly protectedPayload: Redacted.Redacted<string>
  readonly now: number
}

export type ProviderClientCredentialsOutcome =
  | { readonly _tag: 'Acquired'; readonly credentials: ProviderCredentialSet }
  | { readonly _tag: 'ProviderRejected' }
  | { readonly _tag: 'ProviderFailure'; readonly recovery?: 'NotDispatched' }
  | { readonly _tag: 'ProviderOutcomeUnknown' }

export interface ClientCredentialsProviderDefinition<
  SourceCredentials,
  Credentials,
  Requirements = never,
> {
  readonly id: string
  readonly prepareClientCredentials: (
    credentials: SourceCredentials,
  ) => Effect.Effect<PreparedClientCredentials, unknown, Requirements>
  readonly acquireCredentials: (
    input: ClientCredentialsAcquisitionInput,
  ) => Effect.Effect<ProviderClientCredentialsOutcome, never, Requirements>
  readonly projectCredentials: (
    protectedPayload: Redacted.Redacted<string>,
  ) => Effect.Effect<Credentials, unknown, Requirements>
  readonly [providerCredentialsType]?: Credentials
}

export interface ApiKeyProviderDefinition<Credentials, Requirements = never> {
  readonly id: string
  readonly prepareApiKey: (
    apiKey: Redacted.Redacted<string>,
  ) => Effect.Effect<ProviderCredentialSet, unknown, Requirements>
  readonly projectCredentials: (
    protectedPayload: Redacted.Redacted<string>,
  ) => Effect.Effect<Credentials, unknown, Requirements>
  readonly [providerCredentialsType]?: Credentials
}

export interface OAuthProviderDefinition<Credentials, Requirements = never> {
  readonly id: string
  readonly authorizationUrl: (
    input: AuthorizationUrlInput,
  ) => Effect.Effect<string, unknown, Requirements>
  readonly parseAuthorizationCallback: (
    callbackUrl: string,
  ) => Effect.Effect<AuthorizationCallback, unknown, Requirements>
  readonly exchangeAuthorizationCode: (
    input: AuthorizationCodeExchangeInput,
  ) => Effect.Effect<ProviderCredentialSet, ProviderAuthorizationFailure, Requirements>
  readonly refreshCredentials: (
    input: RefreshCredentialInput,
  ) => Effect.Effect<ProviderRefreshOutcome, never, Requirements>
  readonly projectCredentials: (
    protectedPayload: Redacted.Redacted<string>,
  ) => Effect.Effect<Credentials, unknown, Requirements>
  readonly [providerCredentialsType]?: Credentials
}

export interface SelfClientProviderDefinition<Credentials, Requirements = never> {
  readonly id: string
  readonly exchangeSelfClientCode: (input: {
    readonly code: Redacted.Redacted<string>
    readonly now: number
  }) => Effect.Effect<ProviderCredentialSet, ProviderAuthorizationFailure, Requirements>
  readonly refreshCredentials: (
    input: RefreshCredentialInput,
  ) => Effect.Effect<ProviderRefreshOutcome, never, Requirements>
  readonly projectCredentials: (
    protectedPayload: Redacted.Redacted<string>,
  ) => Effect.Effect<Credentials, unknown, Requirements>
  readonly [providerCredentialsType]?: Credentials
}

export type ProviderCredentials<Provider> =
  Provider extends OAuthProviderDefinition<infer Credentials, infer _Requirements>
    ? Credentials
    : Provider extends SelfClientProviderDefinition<infer Credentials, infer _Requirements>
      ? Credentials
      : Provider extends ApiKeyProviderDefinition<infer Credentials, infer _Requirements>
        ? Credentials
        : Provider extends ClientCredentialsProviderDefinition<
              infer _SourceCredentials,
              infer Credentials,
              infer _Requirements
            >
          ? Credentials
          : never
