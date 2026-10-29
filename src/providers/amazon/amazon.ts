import type { Effect, Redacted } from 'effect'
import type { OAuthProviderDefinition } from '../../core/contracts/provider.js'
import type { AmazonCredentials } from './responses.js'
import { makeAmazonTransport } from './transport.js'

export type AmazonText<Requirements = never> =
  | string
  | (() => string)
  | Effect.Effect<string, unknown, Requirements>
export type AmazonSecret<Requirements = never> =
  | string
  | (() => string)
  | Effect.Effect<Redacted.Redacted<string>, unknown, Requirements>

export interface AmazonOAuth<Requirements = never> extends OAuthProviderDefinition<
  AmazonCredentials,
  Requirements
> {
  readonly id: 'amazon'
  readonly configuration: {
    readonly clientId: AmazonText<Requirements>
    readonly clientSecret: AmazonSecret<Requirements>
    readonly redirectUri: AmazonText<Requirements>
    readonly scopes: readonly [string, ...string[]]
    readonly region: 'na' | 'eu' | 'fe'
  }
}

export function oauth<
  ClientIdRequirements = never,
  ClientSecretRequirements = never,
  RedirectUriRequirements = never,
>(options: {
  readonly clientId: AmazonText<ClientIdRequirements>
  readonly clientSecret: AmazonSecret<ClientSecretRequirements>
  readonly redirectUri: AmazonText<RedirectUriRequirements>
  readonly scopes: readonly [string, ...string[]]
  readonly region?: 'na' | 'eu' | 'fe'
}): AmazonOAuth<ClientIdRequirements | ClientSecretRequirements | RedirectUriRequirements> {
  type Requirements = ClientIdRequirements | ClientSecretRequirements | RedirectUriRequirements
  const configuration: AmazonOAuth<Requirements>['configuration'] = Object.freeze({
    ...options,
    region: options.region ?? 'na',
    scopes: Object.freeze([...options.scopes]) as readonly [string, ...string[]],
  })
  return Object.freeze({
    id: 'amazon',
    configuration,
    ...makeAmazonTransport(configuration),
  })
}
