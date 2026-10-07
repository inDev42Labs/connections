import { Effect, Redacted } from 'effect'
import type {
  AuthorizationCallback,
  AuthorizationCodeExchangeInput,
  AuthorizationUrlInput,
  OAuthProviderDefinition,
  ProviderCredentialSet,
  ProviderRefreshOutcome,
  RefreshCredentialInput,
} from '../../core/contracts/provider.js'
import {
  MalformedJsonResponse,
  oauthErrorCode,
  readBoundedJsonResponse,
  readOAuthErrorCode,
} from '../internal/http.js'
import {
  parseAuthorizationCodeResponse,
  parseRefreshResponse,
  parseStoredCredentials,
  projectCredentials,
  type ZohoCredentials,
  ZohoTransportFailure,
} from './responses.js'

export type ZohoText<Requirements = never> =
  | string
  | (() => string)
  | Effect.Effect<string, unknown, Requirements>
export type ZohoSecret<Requirements = never> =
  | string
  | (() => string)
  | Effect.Effect<Redacted.Redacted<string>, unknown, Requirements>

interface ZohoTokenConfiguration<Requirements = never> {
  readonly clientId: ZohoText<Requirements>
  readonly clientSecret: ZohoSecret<Requirements>
  readonly accountsOrigin: ZohoText<Requirements>
}

export interface ZohoOAuthConfiguration<
  Requirements = never,
> extends ZohoTokenConfiguration<Requirements> {
  readonly redirectUri: ZohoText<Requirements>
  readonly scopes: readonly [string, ...string[]]
}

export type ZohoSelfClientConfiguration<Requirements = never> = ZohoTokenConfiguration<Requirements>

export interface ZohoSelfClientCodeExchangeInput {
  readonly code: Redacted.Redacted<string>
  readonly now: number
}

const authorizationPath = '/oauth/v2/auth'
const tokenPath = '/oauth/v2/token'
const timeoutMilliseconds = 30_000
const callbackParameters = new Set(['code', 'state', 'error', 'error_description', 'error_uri'])

type TokenResponse =
  | { readonly _tag: 'ProviderFailure' }
  | { readonly _tag: 'ProviderRejected' }
  | { readonly _tag: 'Success'; readonly body: unknown }

function resolveText<Requirements>(
  value: ZohoText<Requirements>,
): Effect.Effect<string, unknown, Requirements> {
  const text =
    typeof value === 'string'
      ? Effect.succeed(value)
      : typeof value === 'function'
        ? Effect.try({ try: value, catch: (error) => error })
        : value
  return text.pipe(
    Effect.flatMap((resolved) =>
      typeof resolved === 'string'
        ? Effect.succeed(resolved)
        : Effect.fail(new TypeError('Invalid Zoho configuration')),
    ),
  )
}

function resolveSecret<Requirements>(
  value: ZohoSecret<Requirements>,
): Effect.Effect<Redacted.Redacted<string>, unknown, Requirements> {
  if (typeof value === 'string' || typeof value === 'function') {
    return Effect.try({
      try: () => {
        const secret = typeof value === 'string' ? value : value()
        if (typeof secret !== 'string' || secret.length === 0) {
          throw new TypeError('Invalid Zoho configuration')
        }
        return Redacted.make(secret)
      },
      catch: (error) => error,
    })
  }
  return value.pipe(
    Effect.flatMap((secret) =>
      Effect.try({
        try: () => {
          if (Redacted.value(secret).length === 0) {
            throw new TypeError('Invalid Zoho configuration')
          }
          return secret
        },
        catch: (error) => error,
      }),
    ),
  )
}

function isSecureEndpoint(url: URL): boolean {
  return (
    url.protocol === 'https:' ||
    (url.protocol === 'http:' &&
      (url.hostname === '127.0.0.1' || url.hostname === '[::1]' || url.hostname === 'localhost'))
  )
}

function configuredOrigin<Requirements>(
  value: ZohoText<Requirements>,
): Effect.Effect<URL, ZohoTransportFailure, Requirements> {
  return resolveText(value).pipe(
    Effect.mapError(() => new ZohoTransportFailure({ reason: 'InvalidConfiguration' })),
    Effect.flatMap((text) =>
      Effect.try({
        try: () => {
          const url = new URL(text)
          if (
            !isSecureEndpoint(url) ||
            url.username !== '' ||
            url.password !== '' ||
            url.pathname !== '/' ||
            url.search !== '' ||
            url.hash !== ''
          ) {
            throw new TypeError('Invalid Zoho Accounts origin')
          }
          return url
        },
        catch: () => new ZohoTransportFailure({ reason: 'InvalidConfiguration' }),
      }),
    ),
  )
}

function configuredRedirect<Requirements>(
  value: ZohoText<Requirements>,
): Effect.Effect<URL, ZohoTransportFailure, Requirements> {
  return resolveText(value).pipe(
    Effect.mapError(() => new ZohoTransportFailure({ reason: 'InvalidConfiguration' })),
    Effect.flatMap((text) =>
      Effect.try({
        try: () => {
          const url = new URL(text)
          if (
            !isSecureEndpoint(url) ||
            url.username !== '' ||
            url.password !== '' ||
            url.hash !== '' ||
            [...url.searchParams.keys()].some((key) => callbackParameters.has(key))
          ) {
            throw new TypeError('Invalid Zoho redirect URI')
          }
          return url
        },
        catch: () => new ZohoTransportFailure({ reason: 'InvalidConfiguration' }),
      }),
    ),
  )
}

function oneParameter(url: URL, name: string): string | null {
  const values = url.searchParams.getAll(name)
  return values.length === 1 && values[0] !== undefined && values[0].length > 0 ? values[0] : null
}

function callbackMatchesRedirect(callback: URL, redirect: URL): boolean {
  if (
    callback.protocol !== redirect.protocol ||
    callback.host !== redirect.host ||
    callback.pathname !== redirect.pathname ||
    callback.username !== '' ||
    callback.password !== '' ||
    callback.hash !== ''
  ) {
    return false
  }
  for (const [name, expected] of redirect.searchParams) {
    const actual = callback.searchParams.getAll(name)
    const configured = redirect.searchParams.getAll(name)
    if (
      actual.length !== configured.length ||
      actual.some((value, index) => value !== configured[index])
    ) {
      return false
    }
    if (expected.length === 0) return false
  }
  for (const name of callback.searchParams.keys()) {
    if (!redirect.searchParams.has(name) && !callbackParameters.has(name)) return false
  }
  return true
}

function authorizationUrl<Requirements>(
  configuration: ZohoOAuthConfiguration<Requirements>,
  input: AuthorizationUrlInput,
): Effect.Effect<string, ZohoTransportFailure, Requirements> {
  return Effect.all({
    clientId: resolveText(configuration.clientId).pipe(
      Effect.mapError(() => new ZohoTransportFailure({ reason: 'InvalidConfiguration' })),
    ),
    accountsOrigin: configuredOrigin(configuration.accountsOrigin),
    redirectUri: configuredRedirect(configuration.redirectUri),
  }).pipe(
    Effect.map(({ clientId, accountsOrigin, redirectUri }) => {
      if (clientId.length === 0 || configuration.scopes.some((scope) => scope.length === 0)) {
        throw new ZohoTransportFailure({ reason: 'InvalidConfiguration' })
      }
      const destination = new URL(authorizationPath, accountsOrigin)
      destination.search = new URLSearchParams({
        response_type: 'code',
        client_id: clientId,
        redirect_uri: redirectUri.toString(),
        scope: configuration.scopes.join(','),
        access_type: 'offline',
        state: input.state,
        code_challenge: input.codeChallenge,
        code_challenge_method: 'S256',
      }).toString()
      return destination.toString()
    }),
    Effect.catchDefect(() =>
      Effect.fail(new ZohoTransportFailure({ reason: 'InvalidConfiguration' })),
    ),
  )
}

function parseAuthorizationCallback<Requirements>(
  configuration: ZohoOAuthConfiguration<Requirements>,
  callbackUrl: string,
): Effect.Effect<AuthorizationCallback, ZohoTransportFailure, Requirements> {
  return Effect.gen(function* () {
    const redirect = yield* configuredRedirect(configuration.redirectUri)
    const callback = yield* Effect.try({
      try: () => new URL(callbackUrl),
      catch: () => new ZohoTransportFailure({ reason: 'InvalidCallback' }),
    })
    if (!callbackMatchesRedirect(callback, redirect)) {
      return yield* Effect.fail(new ZohoTransportFailure({ reason: 'InvalidCallback' }))
    }
    const state = oneParameter(callback, 'state')
    const code = oneParameter(callback, 'code')
    const error = oneParameter(callback, 'error')
    if (state === null || (code === null) === (error === null)) {
      return yield* Effect.fail(new ZohoTransportFailure({ reason: 'InvalidCallback' }))
    }
    if (error !== null) return { _tag: 'AuthorizationDenied', state }
    if (code === null) {
      return yield* Effect.fail(new ZohoTransportFailure({ reason: 'InvalidCallback' }))
    }
    return {
      _tag: 'AuthorizationGranted',
      state,
      code: Redacted.make(code),
    }
  })
}

function tokenPost(
  url: URL,
  body: URLSearchParams,
  oneTimeCode = false,
  refresh = false,
): Effect.Effect<TokenResponse, ZohoTransportFailure> {
  return Effect.tryPromise({
    try: async (effectSignal) => {
      const controller = new AbortController()
      const abort = () => controller.abort()
      effectSignal.addEventListener('abort', abort, { once: true })
      const timeout = setTimeout(abort, timeoutMilliseconds)
      try {
        const response = await fetch(url, {
          method: 'POST',
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
          body,
          redirect: 'error',
          signal: controller.signal,
        })
        if (!response.ok) {
          if (refresh) {
            if (response.status === 400 || response.status === 401) {
              const error = await readOAuthErrorCode(response)
              return error === 'invalid_code'
                ? { _tag: 'ProviderRejected' as const }
                : { _tag: 'ProviderFailure' as const }
            }
            void response.body?.cancel().catch(() => undefined)
            return { _tag: 'ProviderFailure' as const }
          }
          void response.body?.cancel().catch(() => undefined)
          if (
            oneTimeCode &&
            (response.status === 408 || response.status === 429 || response.status >= 500)
          ) {
            throw new ZohoTransportFailure({ reason: 'TransportFailure' })
          }
          return { _tag: 'ProviderRejected' as const }
        }
        const responseBody = await readBoundedJsonResponse(response)
        if (refresh) {
          const error = oauthErrorCode(responseBody)
          // invalid_code in a refresh-token grant means the retained token is
          // invalid or revoked. invalid_client and access_denied do not.
          // https://www.zoho.com/books/api/v3/oauth/#step4
          if (error !== null) {
            return error === 'invalid_code'
              ? { _tag: 'ProviderRejected' as const }
              : { _tag: 'ProviderFailure' as const }
          }
        }
        return { _tag: 'Success' as const, body: responseBody }
      } finally {
        clearTimeout(timeout)
        effectSignal.removeEventListener('abort', abort)
      }
    },
    catch: (error) =>
      new ZohoTransportFailure({
        reason: error instanceof MalformedJsonResponse ? 'MalformedResponse' : 'TransportFailure',
      }),
  })
}

function exchangeSelfClientCode<Requirements>(
  configuration: ZohoSelfClientConfiguration<Requirements>,
  input: ZohoSelfClientCodeExchangeInput,
): Effect.Effect<ProviderCredentialSet, ZohoTransportFailure, Requirements> {
  return Effect.all({
    clientId: resolveText(configuration.clientId),
    clientSecret: resolveSecret(configuration.clientSecret),
    accountsOrigin: configuredOrigin(configuration.accountsOrigin),
  }).pipe(
    Effect.mapError(() => new ZohoTransportFailure({ reason: 'InvalidConfiguration' })),
    Effect.flatMap(({ clientId, clientSecret, accountsOrigin }) => {
      if (clientId.length === 0) {
        return Effect.fail(new ZohoTransportFailure({ reason: 'InvalidConfiguration' }))
      }
      return tokenPost(
        new URL(tokenPath, accountsOrigin),
        new URLSearchParams({
          grant_type: 'authorization_code',
          client_id: clientId,
          client_secret: Redacted.value(clientSecret),
          code: Redacted.value(input.code),
        }),
        true,
      )
    }),
    Effect.flatMap((response) =>
      response._tag !== 'Success'
        ? Effect.fail(new ZohoTransportFailure({ reason: 'ProviderRejected' }))
        : parseAuthorizationCodeResponse(response.body, input.now),
    ),
  )
}

function exchangeAuthorizationCode<Requirements>(
  configuration: ZohoOAuthConfiguration<Requirements>,
  input: AuthorizationCodeExchangeInput,
): Effect.Effect<ProviderCredentialSet, ZohoTransportFailure, Requirements> {
  return Effect.all({
    clientId: resolveText(configuration.clientId),
    clientSecret: resolveSecret(configuration.clientSecret),
    accountsOrigin: configuredOrigin(configuration.accountsOrigin),
    redirectUri: configuredRedirect(configuration.redirectUri),
  }).pipe(
    Effect.mapError(() => new ZohoTransportFailure({ reason: 'InvalidConfiguration' })),
    Effect.flatMap(({ clientId, clientSecret, accountsOrigin, redirectUri }) => {
      if (clientId.length === 0) {
        return Effect.fail(new ZohoTransportFailure({ reason: 'InvalidConfiguration' }))
      }
      return tokenPost(
        new URL(tokenPath, accountsOrigin),
        new URLSearchParams({
          grant_type: 'authorization_code',
          code: Redacted.value(input.code),
          client_id: clientId,
          client_secret: Redacted.value(clientSecret),
          redirect_uri: redirectUri.toString(),
          code_verifier: Redacted.value(input.codeVerifier),
        }),
      )
    }),
    Effect.flatMap((response) =>
      response._tag !== 'Success'
        ? Effect.fail(new ZohoTransportFailure({ reason: 'ProviderRejected' }))
        : parseAuthorizationCodeResponse(response.body, input.now),
    ),
  )
}

function refreshCredentials<Requirements>(
  configuration: ZohoTokenConfiguration<Requirements>,
  input: RefreshCredentialInput,
): Effect.Effect<ProviderRefreshOutcome, never, Requirements> {
  const previous = parseStoredCredentials(Redacted.value(input.protectedPayload))
  if (previous === null) return Effect.succeed({ _tag: 'ProviderFailure' })

  return Effect.all({
    clientId: resolveText(configuration.clientId),
    clientSecret: resolveSecret(configuration.clientSecret),
    accountsOrigin: configuredOrigin(configuration.accountsOrigin),
  }).pipe(
    Effect.mapError(() => new ZohoTransportFailure({ reason: 'InvalidConfiguration' })),
    Effect.flatMap(({ clientId, clientSecret, accountsOrigin }) => {
      if (clientId.length === 0) {
        return Effect.fail(new ZohoTransportFailure({ reason: 'InvalidConfiguration' }))
      }
      return tokenPost(
        new URL(tokenPath, accountsOrigin),
        new URLSearchParams({
          grant_type: 'refresh_token',
          refresh_token: previous.refreshToken,
          client_id: clientId,
          client_secret: Redacted.value(clientSecret),
        }),
        false,
        true,
      )
    }),
    Effect.flatMap((response): Effect.Effect<ProviderRefreshOutcome, ZohoTransportFailure> =>
      response._tag !== 'Success'
        ? Effect.succeed({ _tag: response._tag })
        : parseRefreshResponse(response.body, previous, input.now).pipe(
            Effect.map((credentials): ProviderRefreshOutcome => ({
              _tag: 'Refreshed',
              credentials,
            })),
          ),
    ),
    Effect.matchEffect({
      onSuccess: Effect.succeed,
      onFailure: (failure) =>
        Effect.succeed<ProviderRefreshOutcome>(
          failure.reason === 'ProviderRejected'
            ? { _tag: 'ProviderRejected' }
            : failure.reason === 'TransportFailure' || failure.reason === 'MalformedResponse'
              ? { _tag: 'ProviderOutcomeUnknown' }
              : failure.reason === 'InvalidConfiguration'
                ? { _tag: 'ProviderFailure', recovery: 'NotDispatched' }
                : { _tag: 'ProviderFailure' },
        ),
    }),
  )
}

export function makeZohoSelfClientTransport<Requirements>(
  configuration: ZohoSelfClientConfiguration<Requirements>,
): {
  readonly exchangeSelfClientCode: (
    input: ZohoSelfClientCodeExchangeInput,
  ) => Effect.Effect<ProviderCredentialSet, ZohoTransportFailure, Requirements>
  readonly refreshCredentials: (
    input: RefreshCredentialInput,
  ) => Effect.Effect<ProviderRefreshOutcome, never, Requirements>
  readonly projectCredentials: (
    protectedPayload: Redacted.Redacted<string>,
  ) => Effect.Effect<ZohoCredentials, ZohoTransportFailure>
} {
  return {
    exchangeSelfClientCode: (input) => exchangeSelfClientCode(configuration, input),
    refreshCredentials: (input) => refreshCredentials(configuration, input),
    projectCredentials,
  }
}

export function makeZohoTransport<Requirements>(
  configuration: ZohoOAuthConfiguration<Requirements>,
): Pick<
  OAuthProviderDefinition<ZohoCredentials, Requirements>,
  | 'authorizationUrl'
  | 'parseAuthorizationCallback'
  | 'exchangeAuthorizationCode'
  | 'refreshCredentials'
  | 'projectCredentials'
> {
  return {
    authorizationUrl: (input) => authorizationUrl(configuration, input),
    parseAuthorizationCallback: (callbackUrl) =>
      parseAuthorizationCallback(configuration, callbackUrl),
    exchangeAuthorizationCode: (input) => exchangeAuthorizationCode(configuration, input),
    refreshCredentials: (input) => refreshCredentials(configuration, input),
    projectCredentials,
  }
}
