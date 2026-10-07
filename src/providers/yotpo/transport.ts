import { Effect, Redacted } from 'effect'
import type {
  ClientCredentialsAcquisitionInput,
  ClientCredentialsProviderDefinition,
  ProviderClientCredentialsOutcome,
} from '../../core/contracts/provider.js'
import { MalformedJsonResponse, readBoundedJsonResponse } from '../internal/http.js'
import {
  parseStoredCredentials,
  parseTokenResponse,
  prepareClientCredentials,
  projectCredentials,
  type YotpoCredentials,
  type YotpoSourceCredentials,
} from './responses.js'

const tokenUrl = new URL('https://api.yotpo.com/oauth/token')
const timeoutMilliseconds = 30_000

type TokenResponse =
  | { readonly _tag: 'HttpFailure'; readonly status: number }
  | { readonly _tag: 'Success'; readonly body: unknown }

export type YotpoFetch = typeof fetch

export interface YotpoV1Configuration {
  readonly fetch?: YotpoFetch
}

function tokenPost(
  fetchImplementation: YotpoFetch,
  body: string,
): Effect.Effect<TokenResponse, unknown> {
  return Effect.tryPromise({
    try: async (effectSignal) => {
      const controller = new AbortController()
      const abort = () => controller.abort()
      effectSignal.addEventListener('abort', abort, { once: true })
      const timeout = setTimeout(abort, timeoutMilliseconds)
      try {
        const response = await fetchImplementation(tokenUrl, {
          method: 'POST',
          headers: {
            accept: 'application/json',
            'content-type': 'application/json',
          },
          body,
          redirect: 'error',
          signal: controller.signal,
        })
        if (!response.ok) {
          void response.body?.cancel().catch(() => undefined)
          return { _tag: 'HttpFailure' as const, status: response.status }
        }
        return { _tag: 'Success' as const, body: await readBoundedJsonResponse(response) }
      } finally {
        clearTimeout(timeout)
        effectSignal.removeEventListener('abort', abort)
      }
    },
    catch: (error) => error,
  })
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

  return tokenPost(
    fetchImplementation,
    JSON.stringify({
      client_id: previous.storeId,
      client_secret: previous.apiSecret,
      grant_type: 'client_credentials',
    }),
  ).pipe(
    Effect.matchEffect({
      onFailure: (error) =>
        Effect.succeed<ProviderClientCredentialsOutcome>(
          error instanceof MalformedJsonResponse
            ? { _tag: 'ProviderFailure' }
            : { _tag: 'ProviderOutcomeUnknown' },
        ),
      onSuccess: (response) => {
        if (response._tag === 'HttpFailure') return Effect.succeed(httpFailure(response.status))
        return parseTokenResponse(response.body, previous).pipe(
          Effect.match({
            onFailure: (): ProviderClientCredentialsOutcome => ({ _tag: 'ProviderFailure' }),
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
