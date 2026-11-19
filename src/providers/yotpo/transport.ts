import { Effect, Redacted } from 'effect'
import type {
  ClientCredentialsAcquisitionInput,
  ClientCredentialsProviderDefinition,
  ProviderClientCredentialsOutcome,
} from '../../core/contracts/provider.js'
import { postCredentialRequest } from '../internal/http.js'
import {
  parseStoredCredentials,
  parseTokenResponse,
  prepareClientCredentials,
  projectCredentials,
  type YotpoCredentials,
  type YotpoSourceCredentials,
} from './responses.js'

const tokenUrl = new URL('https://api.yotpo.com/oauth/token')
export type YotpoFetch = typeof fetch

export interface YotpoV1Configuration {
  readonly fetch?: YotpoFetch
}

function httpFailure(status: number): ProviderClientCredentialsOutcome {
  if (status === 400 || status === 401 || status === 404) return { _tag: 'ProviderRejected' }
  if (status === 429 || status >= 500) return { _tag: 'ProviderOutcomeUnknown' }
  return { _tag: 'ProviderFailure' }
}

function acquireCredentials(
  fetchImplementation: YotpoFetch,
  input: ClientCredentialsAcquisitionInput,
): Effect.Effect<ProviderClientCredentialsOutcome> {
  const previous = parseStoredCredentials(Redacted.value(input.protectedPayload))
  if (previous === null) return Effect.succeed({ _tag: 'ProviderFailure' })

  return postCredentialRequest({
    fetch: fetchImplementation,
    url: tokenUrl,
    headers: { accept: 'application/json', 'content-type': 'application/json' },
    body: JSON.stringify({
      client_id: previous.storeId,
      client_secret: previous.apiSecret,
      grant_type: 'client_credentials',
    }),
  }).pipe(
    Effect.matchEffect({
      onFailure: () =>
        Effect.succeed<ProviderClientCredentialsOutcome>({ _tag: 'ProviderOutcomeUnknown' }),
      onSuccess: (response) => {
        if (response._tag === 'HttpFailure') return Effect.succeed(httpFailure(response.status))
        return parseTokenResponse(response.body, previous).pipe(
          Effect.match({
            onFailure: (): ProviderClientCredentialsOutcome => ({ _tag: 'ProviderOutcomeUnknown' }),
            onSuccess: (credentials): ProviderClientCredentialsOutcome => ({
              _tag: 'Acquired',
              credentials,
            }),
          }),
        )
      },
    }),
  )
}

export function makeYotpoTransport(
  configuration: YotpoV1Configuration,
): Pick<
  ClientCredentialsProviderDefinition<YotpoSourceCredentials, YotpoCredentials>,
  'prepareClientCredentials' | 'acquireCredentials' | 'projectCredentials'
> {
  const fetchImplementation = configuration.fetch ?? fetch
  return {
    prepareClientCredentials,
    acquireCredentials: (input) => acquireCredentials(fetchImplementation, input),
    projectCredentials,
  }
}
