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
import { MalformedJsonResponse, readBoundedJsonResponse } from '../internal/http.js'
import {
  parseAuthorizationCodeResponse,
  parseRefreshResponse,
  parseStoredCredentials,
  projectCredentials,
  SalesforceTransportFailure,
  type SalesforceCredentials,
} from './responses.js'

export type SalesforceText<Requirements = never> =
  | string
  | (() => string)
  | Effect.Effect<string, unknown, Requirements>
export type SalesforceSecret<Requirements = never> =
  | string
  | (() => string)
  | Effect.Effect<Redacted.Redacted<string>, unknown, Requirements>

export interface SalesforceOAuthConfiguration<Requirements = never> {
  readonly clientId: SalesforceText<Requirements>
  readonly clientSecret: SalesforceSecret<Requirements>
  readonly redirectUri: SalesforceText<Requirements>
  readonly scopes: readonly [string, ...string[]]
  readonly loginUrl: SalesforceText<Requirements>
}

const authorizationPath = '/services/oauth2/authorize'
const tokenPath = '/services/oauth2/token'
const timeoutMilliseconds = 30_000
const callbackParameters = new Set(['code', 'state', 'error', 'error_description', 'error_uri'])

type TokenResponse =
  | { readonly _tag: 'ProviderRejected' }
  | { readonly _tag: 'Success'; readonly body: unknown }

function resolveText<Requirements>(
  value: SalesforceText<Requirements>,
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
        : Effect.fail(new TypeError('Invalid Salesforce configuration')),
    ),
  )
}

function resolveSecret<Requirements>(
  value: SalesforceSecret<Requirements>,
): Effect.Effect<Redacted.Redacted<string>, unknown, Requirements> {
  if (typeof value === 'string' || typeof value === 'function') {
    return Effect.try({
      try: () => {
        const secret = typeof value === 'string' ? value : value()
        if (typeof secret !== 'string' || secret.length === 0) {
          throw new TypeError('Invalid Salesforce configuration')
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
            throw new TypeError('Invalid Salesforce configuration')
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

export function configuredUrl<Requirements>(
  value: SalesforceText<Requirements>,
  kind: 'login' | 'redirect',
): Effect.Effect<URL, SalesforceTransportFailure, Requirements> {
  return resolveText(value).pipe(
    Effect.mapError(() => new SalesforceTransportFailure({ reason: 'InvalidConfiguration' })),
    Effect.flatMap((text) =>
      Effect.try({
        try: () => {
          const url = new URL(text)
          if (
            !isSecureEndpoint(url) ||
            url.username !== '' ||
            url.password !== '' ||
            url.hash !== '' ||
            (kind === 'login' && (url.search !== '' || url.pathname !== '/')) ||
            (kind === 'redirect' &&
              [...url.searchParams.keys()].some((key) => callbackParameters.has(key)))
          ) {
            throw new TypeError('Invalid Salesforce URL configuration')
          }
          return url
        },
        catch: () => new SalesforceTransportFailure({ reason: 'InvalidConfiguration' }),
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
  configuration: SalesforceOAuthConfiguration<Requirements>,
  input: AuthorizationUrlInput,
): Effect.Effect<string, SalesforceTransportFailure, Requirements> {
  return Effect.all({
    clientId: resolveText(configuration.clientId).pipe(
      Effect.mapError(() => new SalesforceTransportFailure({ reason: 'InvalidConfiguration' })),
    ),
    loginUrl: configuredUrl(configuration.loginUrl, 'login'),
    redirectUri: configuredUrl(configuration.redirectUri, 'redirect'),
  }).pipe(
    Effect.map(({ clientId, loginUrl, redirectUri }) => {
      if (clientId.length === 0 || configuration.scopes.some((scope) => scope.length === 0)) {
        throw new SalesforceTransportFailure({ reason: 'InvalidConfiguration' })
      }
      const destination = new URL(authorizationPath, loginUrl)
      destination.search = new URLSearchParams({
        response_type: 'code',
        client_id: clientId,
        redirect_uri: redirectUri.toString(),
        scope: configuration.scopes.join(' '),
        state: input.state,
        code_challenge: input.codeChallenge,
        code_challenge_method: 'S256',
      }).toString()
      return destination.toString()
    }),
    Effect.catchDefect(() =>
      Effect.fail(new SalesforceTransportFailure({ reason: 'InvalidConfiguration' })),
    ),
  )
}

function parseAuthorizationCallback<Requirements>(
  configuration: SalesforceOAuthConfiguration<Requirements>,
  callbackUrl: string,
): Effect.Effect<AuthorizationCallback, SalesforceTransportFailure, Requirements> {
  return Effect.gen(function* () {
    const redirect = yield* configuredUrl(configuration.redirectUri, 'redirect')
    const callback = yield* Effect.try({
      try: () => new URL(callbackUrl),
      catch: () => new SalesforceTransportFailure({ reason: 'InvalidCallback' }),
    })
    if (!callbackMatchesRedirect(callback, redirect)) {
      return yield* Effect.fail(new SalesforceTransportFailure({ reason: 'InvalidCallback' }))
    }
    const state = oneParameter(callback, 'state')
    const code = oneParameter(callback, 'code')
    const error = oneParameter(callback, 'error')
    if (state === null || (code === null) === (error === null)) {
      return yield* Effect.fail(new SalesforceTransportFailure({ reason: 'InvalidCallback' }))
    }
    if (error !== null) {
      return { _tag: 'AuthorizationDenied', state }
    }
    if (code === null) {
      return yield* Effect.fail(new SalesforceTransportFailure({ reason: 'InvalidCallback' }))
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
): Effect.Effect<TokenResponse, SalesforceTransportFailure> {
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
          void response.body?.cancel().catch(() => undefined)
          return { _tag: 'ProviderRejected' as const }
        }
        return { _tag: 'Success' as const, body: await readBoundedJsonResponse(response) }
      } finally {
        clearTimeout(timeout)
        effectSignal.removeEventListener('abort', abort)
      }
    },
    catch: (error) =>
      new SalesforceTransportFailure({
        reason: error instanceof MalformedJsonResponse ? 'MalformedResponse' : 'TransportFailure',
      }),
  })
}

function refreshCredentials<Requirements>(
  configuration: SalesforceOAuthConfiguration<Requirements>,
  input: RefreshCredentialInput,
): Effect.Effect<ProviderRefreshOutcome, never, Requirements> {
  const previous = parseStoredCredentials(Redacted.value(input.protectedPayload))
  if (previous === null) return Effect.succeed({ _tag: 'ProviderFailure' })

  return Effect.all({
    clientId: resolveText(configuration.clientId),
    clientSecret: resolveSecret(configuration.clientSecret),
    loginUrl: configuredUrl(configuration.loginUrl, 'login'),
  }).pipe(
    Effect.mapError(() => new SalesforceTransportFailure({ reason: 'InvalidConfiguration' })),
    Effect.flatMap(({ clientId, clientSecret, loginUrl }) => {
      if (clientId.length === 0) {
        return Effect.fail(new SalesforceTransportFailure({ reason: 'InvalidConfiguration' }))
      }
      return tokenPost(
        new URL(tokenPath, loginUrl),
        new URLSearchParams({
          grant_type: 'refresh_token',
          refresh_token: previous.refreshToken,
          client_id: clientId,
          client_secret: Redacted.value(clientSecret),
        }),
      )
    }),
    Effect.flatMap((response) =>
      response._tag === 'ProviderRejected'
        ? Effect.fail(new SalesforceTransportFailure({ reason: 'ProviderRejected' }))
        : parseRefreshResponse(response.body, previous, input.now),
    ),
    Effect.matchEffect({
      onSuccess: (credentials) =>
        Effect.succeed<ProviderRefreshOutcome>({ _tag: 'Refreshed', credentials }),
      onFailure: (failure) =>
        Effect.succeed<ProviderRefreshOutcome>(
          failure.reason === 'ProviderRejected'
            ? { _tag: 'ProviderRejected' }
            : failure.reason === 'TransportFailure'
              ? { _tag: 'ProviderOutcomeUnknown' }
              : { _tag: 'ProviderFailure' },
        ),
    }),
  )
}

function exchangeAuthorizationCode<Requirements>(
  configuration: SalesforceOAuthConfiguration<Requirements>,
  input: AuthorizationCodeExchangeInput,
): Effect.Effect<ProviderCredentialSet, SalesforceTransportFailure, Requirements> {
  return Effect.all({
    clientId: resolveText(configuration.clientId),
    clientSecret: resolveSecret(configuration.clientSecret),
    loginUrl: configuredUrl(configuration.loginUrl, 'login'),
    redirectUri: configuredUrl(configuration.redirectUri, 'redirect'),
  }).pipe(
    Effect.mapError(() => new SalesforceTransportFailure({ reason: 'InvalidConfiguration' })),
    Effect.flatMap(({ clientId, clientSecret, loginUrl, redirectUri }) => {
      if (clientId.length === 0) {
        return Effect.fail(new SalesforceTransportFailure({ reason: 'InvalidConfiguration' }))
      }
      const body = new URLSearchParams({
        grant_type: 'authorization_code',
        code: Redacted.value(input.code),
        client_id: clientId,
        client_secret: Redacted.value(clientSecret),
        redirect_uri: redirectUri.toString(),
        code_verifier: Redacted.value(input.codeVerifier),
      })
      return tokenPost(new URL(tokenPath, loginUrl), body)
    }),
    Effect.flatMap((response) =>
      response._tag === 'ProviderRejected'
        ? Effect.fail(new SalesforceTransportFailure({ reason: 'ProviderRejected' }))
        : parseAuthorizationCodeResponse(response.body, input.now),
    ),
  )
}

export function makeSalesforceTransport<Requirements>(
  configuration: SalesforceOAuthConfiguration<Requirements>,
): Pick<
  OAuthProviderDefinition<SalesforceCredentials, Requirements>,
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
