import type { OAuthProviderDefinition } from '../../core/contracts/provider.js'
import { makeSalesforceTransport, type SalesforceSecret, type SalesforceText } from './transport.js'
import type { SalesforceCredentials } from './responses.js'

export type { SalesforceCredentials } from './responses.js'
export type { SalesforceSecret, SalesforceText } from './transport.js'

export interface SalesforceOAuth<Requirements = never> extends OAuthProviderDefinition<
  SalesforceCredentials,
  Requirements
> {
  readonly id: 'salesforce'
  readonly configuration: {
    readonly clientId: SalesforceText<Requirements>
    readonly clientSecret: SalesforceSecret<Requirements>
    readonly redirectUri: SalesforceText<Requirements>
    readonly scopes: readonly [string, ...string[]]
    readonly loginUrl: SalesforceText<Requirements>
  }
}

export function oauth<
  ClientIdRequirements = never,
  ClientSecretRequirements = never,
  RedirectUriRequirements = never,
  LoginUrlRequirements = never,
>(options: {
  readonly clientId: SalesforceText<ClientIdRequirements>
  readonly clientSecret: SalesforceSecret<ClientSecretRequirements>
  readonly redirectUri: SalesforceText<RedirectUriRequirements>
  readonly scopes: readonly [string, ...string[]]
  readonly loginUrl?: SalesforceText<LoginUrlRequirements>
}): SalesforceOAuth<
  ClientIdRequirements | ClientSecretRequirements | RedirectUriRequirements | LoginUrlRequirements
> {
  type Requirements =
    | ClientIdRequirements
    | ClientSecretRequirements
    | RedirectUriRequirements
    | LoginUrlRequirements
  const configuration: SalesforceOAuth<Requirements>['configuration'] = Object.freeze({
    ...options,
    loginUrl: options.loginUrl ?? 'https://login.salesforce.com',
    scopes: Object.freeze(options.scopes),
  })
  return Object.freeze({
    id: 'salesforce',
    configuration,
    ...makeSalesforceTransport(configuration),
  })
}
