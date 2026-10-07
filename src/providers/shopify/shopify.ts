import type { OAuthProviderDefinition } from '../../core/contracts/provider.js'
import type { ShopifyCredentials } from './responses.js'
import { makeShopifyTransport, type ShopifySecret, type ShopifyText } from './transport.js'

export type { ShopifyCredentials } from './responses.js'
export type { ShopifySecret, ShopifyText } from './transport.js'

export interface ShopifyOAuth<Requirements = never> extends OAuthProviderDefinition<
  ShopifyCredentials,
  Requirements
> {
  readonly id: 'shopify'
  readonly configuration: {
    readonly clientId: ShopifyText<Requirements>
    readonly clientSecret: ShopifySecret<Requirements>
    readonly redirectUri: ShopifyText<Requirements>
    readonly scopes: readonly [string, ...string[]]
    readonly shopDomain: string
  }
}

export function oauth<
  ClientIdRequirements = never,
  ClientSecretRequirements = never,
  RedirectUriRequirements = never,
>(options: {
  readonly clientId: ShopifyText<ClientIdRequirements>
  readonly clientSecret: ShopifySecret<ClientSecretRequirements>
  readonly redirectUri: ShopifyText<RedirectUriRequirements>
  readonly scopes: readonly [string, ...string[]]
  readonly shopDomain: string
}): ShopifyOAuth<ClientIdRequirements | ClientSecretRequirements | RedirectUriRequirements> {
  type Requirements = ClientIdRequirements | ClientSecretRequirements | RedirectUriRequirements
  const configuration: ShopifyOAuth<Requirements>['configuration'] = Object.freeze({
    ...options,
    scopes: Object.freeze([...options.scopes]) as readonly [string, ...string[]],
  })
  return Object.freeze({
    id: 'shopify',
    configuration,
    ...makeShopifyTransport(configuration),
  })
}
