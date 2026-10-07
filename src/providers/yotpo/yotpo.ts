import type { ClientCredentialsProviderDefinition } from '../../core/contracts/provider.js'
import type { YotpoCredentials, YotpoSourceCredentials } from './responses.js'
import { makeYotpoTransport, type YotpoV1Configuration } from './transport.js'

export type { YotpoCredentials, YotpoSourceCredentials } from './responses.js'
export type { YotpoFetch, YotpoV1Configuration } from './transport.js'

export interface YotpoClientCredentialsOptions extends YotpoV1Configuration {
  readonly version: 'v1'
}

export interface YotpoV1 extends ClientCredentialsProviderDefinition<
  YotpoSourceCredentials,
  YotpoCredentials
> {
  readonly id: 'yotpo-ugc-v1'
}

export function clientCredentials({
  version: _version,
  ...options
}: YotpoClientCredentialsOptions): YotpoV1 {
  return Object.freeze({
    id: 'yotpo-ugc-v1' as const,
    ...makeYotpoTransport(options),
  })
}
