import { Effect, Redacted } from 'effect'
import type {
  ClientCredentialsAcquisitionInput,
  ClientCredentialsProviderDefinition,
  ProviderClientCredentialsOutcome,
} from '../../core/contracts/provider.js'
import { MalformedJsonResponse, readBoundedJsonResponse } from '../internal/http.js'
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
        return Effect.succeed<ProviderClientCredentialsOutcome>({ _tag: 'ProviderFailure' })
      return Effect.tryPromise({
        try: async (
          effectSignal,
        ): Promise<
          ProviderClientCredentialsOutcome | { readonly _tag: 'Response'; readonly body: unknown }
        > => {
          const controller = new AbortController()
          const abort = () => controller.abort()
          effectSignal.addEventListener('abort', abort, { once: true })
          const timeout = setTimeout(abort, 30_000)
          try {
            const response = await (options.fetch ?? fetch)(
              new URL('/services/oauth2/token', loginUrl),
              {
                method: 'POST',
                headers: {
                  accept: 'application/json',
                  'content-type': 'application/x-www-form-urlencoded',
                },
                body: new URLSearchParams({
                  grant_type: 'client_credentials',
                  client_id: previous.clientId,
                  client_secret: previous.clientSecret,
                }),
                redirect: 'error',
                signal: controller.signal,
              },
            )
            if (!response.ok) {
              void response.body?.cancel().catch(() => undefined)
              if (response.status === 400 || response.status === 401)
                return { _tag: 'ProviderRejected' }
              if (response.status === 429 || response.status >= 500)
                return { _tag: 'ProviderOutcomeUnknown' }
              return { _tag: 'ProviderFailure' }
            }
            return { _tag: 'Response', body: await readBoundedJsonResponse(response) }
          } finally {
            clearTimeout(timeout)
            effectSignal.removeEventListener('abort', abort)
          }
        },
        catch: (error) => error,
      }).pipe(
        Effect.flatMap((response) =>
          response._tag !== 'Response'
            ? Effect.succeed(response)
            : parseTokenResponse(response.body, previous, input.now).pipe(
                Effect.match({
                  onFailure: (): ProviderClientCredentialsOutcome => ({ _tag: 'ProviderFailure' }),
                  onSuccess: (credentials): ProviderClientCredentialsOutcome => ({
                    _tag: 'Acquired',
                    credentials,
                  }),
                }),
              ),
        ),
        Effect.catch((error) =>
          Effect.succeed<ProviderClientCredentialsOutcome>(
            error instanceof MalformedJsonResponse
              ? { _tag: 'ProviderFailure' }
              : { _tag: 'ProviderOutcomeUnknown' },
          ),
        ),
      )
    }),
    Effect.catch(() =>
      Effect.succeed<ProviderClientCredentialsOutcome>({ _tag: 'ProviderFailure' }),
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
