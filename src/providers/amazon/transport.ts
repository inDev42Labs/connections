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
import { MalformedJsonResponse, oauthErrorCode, postCredentialRequest } from '../internal/http.js'
import type { AmazonOAuth, AmazonSecret, AmazonText } from './amazon.js'
import {
  AmazonTransportFailure,
  parseStoredCredentials,
  parseTokenResponse,
  projectCredentials,
} from './responses.js'
import type { AmazonCredentials } from './responses.js'

type Configuration<Requirements> = AmazonOAuth<Requirements>['configuration']
const callbackParameters = new Set([
  'code',
  'state',
  'scope',
  'error',
  'error_description',
  'error_uri',
])
// https://advertising.amazon.com/API/docs/en-us/guides/account-management/authorization/authorization-grants
const endpoints = {
  na: {
    authorization: 'https://www.amazon.com/ap/oa',
    token: 'https://api.amazon.com/auth/o2/token',
  },
  eu: {
    authorization: 'https://eu.account.amazon.com/ap/oa',
    token: 'https://api.amazon.co.uk/auth/o2/token',
  },
  fe: {
    authorization: 'https://apac.account.amazon.com/ap/oa',
    token: 'https://api.amazon.co.jp/auth/o2/token',
  },
} as const

function configuredEndpoints<Requirements>(configuration: Configuration<Requirements>) {
  return Effect.try({
    try: () => {
      const region = configuration.region
      if (region !== 'na' && region !== 'eu' && region !== 'fe') throw new TypeError()
      return endpoints[region]
    },
    catch: () => new AmazonTransportFailure({ reason: 'InvalidConfiguration' }),
  })
}

function resolveText<Requirements>(
  value: AmazonText<Requirements>,
): Effect.Effect<string, AmazonTransportFailure, Requirements> {
  return (
    typeof value === 'string'
      ? Effect.succeed(value)
      : typeof value === 'function'
        ? Effect.try({ try: value, catch: () => undefined })
        : value
  ).pipe(
    Effect.mapError(() => new AmazonTransportFailure({ reason: 'InvalidConfiguration' })),
    Effect.flatMap((text) =>
      typeof text === 'string' && text.length > 0
        ? Effect.succeed(text)
        : Effect.fail(new AmazonTransportFailure({ reason: 'InvalidConfiguration' })),
    ),
  )
}

function resolveSecret<Requirements>(
  value: AmazonSecret<Requirements>,
): Effect.Effect<string, AmazonTransportFailure, Requirements> {
  if (typeof value === 'string' || typeof value === 'function') return resolveText(value)
  return value.pipe(
    Effect.flatMap((secret) =>
      Effect.try({ try: () => Redacted.value(secret), catch: () => undefined }),
    ),
    Effect.mapError(() => new AmazonTransportFailure({ reason: 'InvalidConfiguration' })),
    Effect.flatMap((text) => resolveText<never>(text)),
  )
}

function redirectUrl<Requirements>(
  configuration: Configuration<Requirements>,
): Effect.Effect<URL, AmazonTransportFailure, Requirements> {
  return resolveText(configuration.redirectUri).pipe(
    Effect.flatMap((text) =>
      Effect.try({
        try: () => {
          const url = new URL(text)
          const secure =
            url.protocol === 'https:' ||
            (url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))
          if (
            !secure ||
            url.username !== '' ||
            url.password !== '' ||
            url.hash !== '' ||
            [...url.searchParams.keys()].some((name) => callbackParameters.has(name))
          ) {
            throw new TypeError()
          }
          return url
        },
        catch: () => new AmazonTransportFailure({ reason: 'InvalidConfiguration' }),
      }),
    ),
  )
}

function authorizationUrl<Requirements>(
  configuration: Configuration<Requirements>,
  input: AuthorizationUrlInput,
): Effect.Effect<string, AmazonTransportFailure, Requirements> {
  return Effect.gen(function* () {
    const clientId = yield* resolveText(configuration.clientId)
    const redirect = yield* redirectUrl(configuration)
    if (
      configuration.scopes.length === 0 ||
      configuration.scopes.some((scope) => typeof scope !== 'string' || scope.length === 0)
    ) {
      return yield* Effect.fail(new AmazonTransportFailure({ reason: 'InvalidConfiguration' }))
    }
    const endpoint = yield* configuredEndpoints(configuration)
    const url = new URL(endpoint.authorization)
    url.search = new URLSearchParams({
      client_id: clientId,
      redirect_uri: redirect.toString(),
      scope: configuration.scopes.join(' '),
      response_type: 'code',
      state: input.state,
      code_challenge: input.codeChallenge,
      code_challenge_method: 'S256',
    }).toString()
    return url.toString()
  })
}

function parseAuthorizationCallback<Requirements>(
  configuration: Configuration<Requirements>,
  callbackUrl: string,
): Effect.Effect<AuthorizationCallback, AmazonTransportFailure, Requirements> {
  return Effect.gen(function* () {
    const redirect = yield* redirectUrl(configuration)
    const callback = yield* Effect.try({
      try: () => new URL(callbackUrl),
      catch: () => new AmazonTransportFailure({ reason: 'InvalidCallback' }),
    })
    if (
      callback.origin !== redirect.origin ||
      callback.pathname !== redirect.pathname ||
      callback.username !== '' ||
      callback.password !== '' ||
      callback.hash !== ''
    ) {
      return yield* Effect.fail(new AmazonTransportFailure({ reason: 'InvalidCallback' }))
    }
    for (const name of new Set([
      ...redirect.searchParams.keys(),
      ...callback.searchParams.keys(),
    ])) {
      const actual = callback.searchParams.getAll(name)
      const expected = redirect.searchParams.getAll(name)
      if (
        expected.length > 0
          ? actual.length !== expected.length ||
            actual.some((value, index) => value !== expected[index])
          : !callbackParameters.has(name) || actual.length !== 1
      ) {
        return yield* Effect.fail(new AmazonTransportFailure({ reason: 'InvalidCallback' }))
      }
    }
    const state = callback.searchParams.get('state')
    const code = callback.searchParams.get('code')
    const error = callback.searchParams.get('error')
    if (!state || (code === null) === (error === null) || code === '' || error === '') {
      return yield* Effect.fail(new AmazonTransportFailure({ reason: 'InvalidCallback' }))
    }
    return code === null
      ? { _tag: 'AuthorizationDenied', state }
      : { _tag: 'AuthorizationGranted', state, code: Redacted.make(code) }
  })
}

function tokenRequestFailure(error: unknown): AmazonTransportFailure {
  return new AmazonTransportFailure({
    reason: error instanceof MalformedJsonResponse ? 'MalformedResponse' : 'TransportFailure',
  })
}

function exchangeAuthorizationCode<Requirements>(
  configuration: Configuration<Requirements>,
  input: AuthorizationCodeExchangeInput,
): Effect.Effect<ProviderCredentialSet, AmazonTransportFailure, Requirements> {
  return Effect.gen(function* () {
    const clientId = yield* resolveText(configuration.clientId)
    const clientSecret = yield* resolveSecret(configuration.clientSecret)
    const redirect = yield* redirectUrl(configuration)
    const endpoint = yield* configuredEndpoints(configuration)
    const response = yield* postCredentialRequest({
      url: new URL(endpoint.token),
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code: Redacted.value(input.code),
        client_id: clientId,
        client_secret: clientSecret,
        redirect_uri: redirect.toString(),
        code_verifier: Redacted.value(input.codeVerifier),
      }),
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
    }).pipe(Effect.mapError(tokenRequestFailure))
    return response._tag === 'Success'
      ? yield* parseTokenResponse(response.body, input.now)
      : yield* Effect.fail(new AmazonTransportFailure({ reason: 'ProviderRejected' }))
  })
}

function refreshCredentials<Requirements>(
  configuration: Configuration<Requirements>,
  input: RefreshCredentialInput,
): Effect.Effect<ProviderRefreshOutcome, never, Requirements> {
  const previous = parseStoredCredentials(Redacted.value(input.protectedPayload))
  if (previous === null) return Effect.succeed({ _tag: 'ProviderFailure' })
  return Effect.gen(function* () {
    const clientId = yield* resolveText(configuration.clientId)
    const clientSecret = yield* resolveSecret(configuration.clientSecret)
    const endpoint = yield* configuredEndpoints(configuration)
    const response = yield* postCredentialRequest({
      url: new URL(endpoint.token),
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: previous.refreshToken,
        client_id: clientId,
        client_secret: clientSecret,
      }),
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      errorBodyStatuses: [400, 401],
    }).pipe(Effect.mapError(tokenRequestFailure))
    if (response._tag !== 'Success') {
      // OAuth token errors distinguish a rejected grant from app authentication failure.
      // https://www.rfc-editor.org/rfc/rfc6749#section-5.2
      return {
        _tag:
          oauthErrorCode(response.body) === 'invalid_grant'
            ? 'ProviderRejected'
            : 'ProviderFailure',
      } as const
    }
    const credentials = yield* parseTokenResponse(response.body, input.now, previous.refreshToken)
    return { _tag: 'Refreshed', credentials } as const
  }).pipe(
    Effect.catch((failure) =>
      Effect.succeed<ProviderRefreshOutcome>(
        failure.reason === 'InvalidConfiguration'
          ? { _tag: 'ProviderFailure', recovery: 'NotDispatched' }
          : { _tag: 'ProviderOutcomeUnknown' },
      ),
    ),
  )
}

export function makeAmazonTransport<Requirements>(
  configuration: Configuration<Requirements>,
): Pick<
  OAuthProviderDefinition<AmazonCredentials, Requirements>,
  | 'authorizationUrl'
  | 'parseAuthorizationCallback'
  | 'exchangeAuthorizationCode'
  | 'refreshCredentials'
  | 'projectCredentials'
> {
  return {
    authorizationUrl: (input) => authorizationUrl(configuration, input),
    parseAuthorizationCallback: (url) => parseAuthorizationCallback(configuration, url),
    exchangeAuthorizationCode: (input) => exchangeAuthorizationCode(configuration, input),
    refreshCredentials: (input) => refreshCredentials(configuration, input),
    projectCredentials,
  }
}
