import { Effect, Redacted } from 'effect'
import type {
  ClientCredentialsAcquisitionInput,
  ClientCredentialsProviderDefinition,
  ProviderClientCredentialsOutcome,
} from '../../core/contracts/provider.js'
import { postCredentialRequest } from '../internal/http.js'
import { configuredUrl, type SalesforceText } from './transport.js'
import type { SalesforceCredentials } from './responses.js'
import {
  parseStoredCredentials,
  parseTokenResponse,
  prepareClientCredentials,
  projectCredentials,
  type SalesforceSourceCredentials,
} from './client-credentials-responses.js'

export type { SalesforceSourceCredentials } from './client-credentials-responses.js'

export interface SalesforceClientCredentialsOptions<Requirements = never> {
  readonly loginUrl: SalesforceText<Requirements>
  readonly fetch?: (...args: Parameters<typeof fetch>) => ReturnType<typeof fetch>
}

export interface SalesforceClientCredentials<
  Requirements = never,
> extends ClientCredentialsProviderDefinition<
  SalesforceSourceCredentials,
  SalesforceCredentials,
  Requirements
> {
  readonly id: 'salesforce-client-credentials'
}

function acquireCredentials<Requirements>(
  options: SalesforceClientCredentialsOptions<Requirements>,
  input: ClientCredentialsAcquisitionInput,
): Effect.Effect<ProviderClientCredentialsOutcome, never, Requirements> {
  const previous = parseStoredCredentials(Redacted.value(input.protectedPayload))
  if (previous === null) return Effect.succeed({ _tag: 'ProviderFailure' })
  // Salesforce requires the org's My Domain endpoint, not the global login hosts.
  // https://help.salesforce.com/s/articleView?id=sf.remoteaccess_oauth_client_credentials_flow.htm&type=5
  return configuredUrl(options.loginUrl, 'login').pipe(
    Effect.flatMap((loginUrl) => {
      if (
        loginUrl.hostname === 'login.salesforce.com' ||
        loginUrl.hostname === 'test.salesforce.com'
      )
        return Effect.succeed<ProviderClientCredentialsOutcome>({
          _tag: 'ProviderFailure',
          recovery: 'NotDispatched',
        })
      return postCredentialRequest({
        ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
        url: new URL('/services/oauth2/token', loginUrl),
        headers: {
          accept: 'application/json',
          'content-type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams({
          grant_type: 'client_credentials',
          client_id: previous.clientId,
          client_secret: previous.clientSecret,
        }),
      }).pipe(
        Effect.flatMap((response): Effect.Effect<ProviderClientCredentialsOutcome> => {
          if (response._tag === 'HttpFailure') {
            if (response.status === 400 || response.status === 401)
              return Effect.succeed({ _tag: 'ProviderRejected' })
            if (response.status === 429 || response.status >= 500)
              return Effect.succeed({ _tag: 'ProviderOutcomeUnknown' })
            return Effect.succeed({ _tag: 'ProviderFailure' })
          }
          return parseTokenResponse(response.body, previous, input.now).pipe(
            Effect.match({
              onFailure: (): ProviderClientCredentialsOutcome => ({
                _tag: 'ProviderOutcomeUnknown',
              }),
              onSuccess: (credentials): ProviderClientCredentialsOutcome => ({
                _tag: 'Acquired',
                credentials,
              }),
            }),
          )
        }),
        Effect.catch(() =>
          Effect.succeed<ProviderClientCredentialsOutcome>({ _tag: 'ProviderOutcomeUnknown' }),
        ),
      )
    }),
    Effect.catch(() =>
      Effect.succeed<ProviderClientCredentialsOutcome>({
        _tag: 'ProviderFailure',
        recovery: 'NotDispatched',
      }),
    ),
  )
}

export function clientCredentials<Requirements = never>(
  options: SalesforceClientCredentialsOptions<Requirements>,
): SalesforceClientCredentials<Requirements> {
  const configuration = Object.freeze({ ...options })
  return Object.freeze({
    id: 'salesforce-client-credentials' as const,
    prepareClientCredentials,
    acquireCredentials: (input: ClientCredentialsAcquisitionInput) =>
      acquireCredentials(configuration, input),
    projectCredentials,
  })
}
