import type { Effect, Redacted } from 'effect'
import type {
  OAuthProviderDefinition,
  ProviderAuthorizationFailure,
  ProviderCredentialSet,
  ProviderRefreshOutcome,
  RefreshCredentialInput,
} from '../../core/contracts/provider.js'
import type { ZohoCredentials } from './responses.js'
import {
  makeZohoSelfClientTransport,
  makeZohoTransport,
  type ZohoSecret,
  type ZohoSelfClientCodeExchangeInput,
  type ZohoText,
} from './transport.js'

export type { ZohoCredentials } from './responses.js'
export type { ZohoSecret, ZohoText } from './transport.js'

export interface ZohoOAuth<Requirements = never> extends OAuthProviderDefinition<
  ZohoCredentials,
  Requirements
> {
  readonly id: 'zoho'
  readonly configuration: {
    readonly clientId: ZohoText<Requirements>
    readonly clientSecret: ZohoSecret<Requirements>
    readonly redirectUri: ZohoText<Requirements>
    readonly scopes: readonly [string, ...string[]]
    readonly accountsOrigin: ZohoText<Requirements>
  }
}

/**
 * Local provider capability for Zoho Self Client code exchange. This intentionally does not
 * implement the browser OAuth contract until the core provider mode supports code enrollment.
 */
export interface ZohoSelfClient<Requirements = never> {
  readonly id: 'zoho-self-client'
  readonly configuration: {
    readonly clientId: ZohoText<Requirements>
    readonly clientSecret: ZohoSecret<Requirements>
    readonly accountsOrigin: ZohoText<Requirements>
  }
  readonly exchangeSelfClientCode: (
    input: ZohoSelfClientCodeExchangeInput,
  ) => Effect.Effect<ProviderCredentialSet, ProviderAuthorizationFailure, Requirements>
  readonly refreshCredentials: (
    input: RefreshCredentialInput,
  ) => Effect.Effect<ProviderRefreshOutcome, never, Requirements>
  readonly projectCredentials: (
    protectedPayload: Redacted.Redacted<string>,
  ) => Effect.Effect<ZohoCredentials, ProviderAuthorizationFailure>
}

export function selfClient<
  ClientIdRequirements = never,
  ClientSecretRequirements = never,
  AccountsOriginRequirements = never,
>(options: {
  readonly clientId: ZohoText<ClientIdRequirements>
  readonly clientSecret: ZohoSecret<ClientSecretRequirements>
  readonly accountsOrigin: ZohoText<AccountsOriginRequirements>
}): ZohoSelfClient<ClientIdRequirements | ClientSecretRequirements | AccountsOriginRequirements> {
  type Requirements = ClientIdRequirements | ClientSecretRequirements | AccountsOriginRequirements
  const configuration: ZohoSelfClient<Requirements>['configuration'] = Object.freeze({
    ...options,
  })
  return Object.freeze({
    id: 'zoho-self-client',
    configuration,
    ...makeZohoSelfClientTransport(configuration),
  })
}

export function oauth<
  ClientIdRequirements = never,
  ClientSecretRequirements = never,
  RedirectUriRequirements = never,
  AccountsOriginRequirements = never,
>(options: {
  readonly clientId: ZohoText<ClientIdRequirements>
  readonly clientSecret: ZohoSecret<ClientSecretRequirements>
  readonly redirectUri: ZohoText<RedirectUriRequirements>
  readonly scopes: readonly [string, ...string[]]
  readonly accountsOrigin: ZohoText<AccountsOriginRequirements>
}): ZohoOAuth<
  | ClientIdRequirements
  | ClientSecretRequirements
  | RedirectUriRequirements
  | AccountsOriginRequirements
> {
  type Requirements =
    | ClientIdRequirements
    | ClientSecretRequirements
    | RedirectUriRequirements
    | AccountsOriginRequirements
  const configuration: ZohoOAuth<Requirements>['configuration'] = Object.freeze({
    ...options,
    scopes: Object.freeze([...options.scopes]) as readonly [string, ...string[]],
  })
  return Object.freeze({
    id: 'zoho',
    configuration,
    ...makeZohoTransport(configuration),
  })
}
