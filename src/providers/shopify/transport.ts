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
  parseShopDomain,
  parseStoredCredentials,
  parseTokenResponse,
  projectCredentials,
  type ShopifyCredentials,
  ShopifyTransportFailure,
} from './responses.js'

export type ShopifyText<Requirements = never> =
  | string
  | (() => string)
  | Effect.Effect<string, unknown, Requirements>
export type ShopifySecret<Requirements = never> =
  | string
  | (() => string)
  | Effect.Effect<Redacted.Redacted<string>, unknown, Requirements>

export interface ShopifyOAuthConfiguration<Requirements = never> {
  readonly clientId: ShopifyText<Requirements>
  readonly clientSecret: ShopifySecret<Requirements>
  readonly redirectUri: ShopifyText<Requirements>
  readonly scopes: readonly [string, ...string[]]
  readonly shopDomain: string
}

const authorizationPath = '/admin/oauth/authorize'
const tokenPath = '/admin/oauth/access_token'
const timeoutMilliseconds = 30_000
const maximumRefreshAttempts = 3
const requiredCallbackParameters = ['code', 'state', 'shop', 'hmac'] as const
const optionalCallbackParameters = new Set(['host', 'timestamp'])
const callbackParameters = new Set([...requiredCallbackParameters, ...optionalCallbackParameters])

type TokenResponse =
  | { readonly _tag: 'HttpFailure'; readonly status: number }
  | { readonly _tag: 'Success'; readonly body: unknown }

function resolveText<Requirements>(
  value: ShopifyText<Requirements>,
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
        : Effect.fail(new TypeError('Invalid Shopify configuration')),
    ),
  )
}

function resolveSecret<Requirements>(
  value: ShopifySecret<Requirements>,
): Effect.Effect<Redacted.Redacted<string>, unknown, Requirements> {
  if (typeof value === 'string' || typeof value === 'function') {
    return Effect.try({
      try: () => {
        const secret = typeof value === 'string' ? value : value()
        if (typeof secret !== 'string' || secret.length === 0) {
          throw new TypeError('Invalid Shopify configuration')
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
            throw new TypeError('Invalid Shopify configuration')
          }
          return secret
        },
        catch: (error) => error,
      }),
    ),
  )
}

function invalidConfiguration(): ShopifyTransportFailure {
  return new ShopifyTransportFailure({ reason: 'InvalidConfiguration' })
}

function invalidCallback(): ShopifyTransportFailure {
  return new ShopifyTransportFailure({ reason: 'InvalidCallback' })
}

function isSecureEndpoint(url: URL): boolean {
  return (
    url.protocol === 'https:' ||
    (url.protocol === 'http:' &&
      (url.hostname === '127.0.0.1' || url.hostname === '[::1]' || url.hostname === 'localhost'))
  )
}

function configuredShopDomain(value: string): Effect.Effect<string, ShopifyTransportFailure> {
  const shopDomain = parseShopDomain(value)
  return shopDomain === null ? Effect.fail(invalidConfiguration()) : Effect.succeed(shopDomain)
}

function configuredRedirect<Requirements>(
  value: ShopifyText<Requirements>,
): Effect.Effect<URL, ShopifyTransportFailure, Requirements> {
  return resolveText(value).pipe(
    Effect.mapError(invalidConfiguration),
    Effect.flatMap((text) =>
      Effect.try({
        try: () => {
          const url = new URL(text)
          const keys = [...url.searchParams.keys()]
          if (
            !isSecureEndpoint(url) ||
            url.username !== '' ||
            url.password !== '' ||
            url.hash !== '' ||
            keys.some(
              (key) =>
                callbackParameters.has(key) ||
                url.searchParams.getAll(key).length !== 1 ||
                url.searchParams.get(key) === '',
            )
          ) {
            throw new TypeError('Invalid Shopify redirect URI')
          }
          return url
        },
        catch: invalidConfiguration,
      }),
    ),
  )
}

function configuredClientId<Requirements>(
  value: ShopifyText<Requirements>,
): Effect.Effect<string, ShopifyTransportFailure, Requirements> {
  return resolveText(value).pipe(
    Effect.mapError(invalidConfiguration),
    Effect.flatMap((clientId) =>
      clientId.length > 0 && clientId.trim() === clientId
        ? Effect.succeed(clientId)
        : Effect.fail(invalidConfiguration()),
    ),
  )
}

function configuredClientSecret<Requirements>(
  value: ShopifySecret<Requirements>,
): Effect.Effect<Redacted.Redacted<string>, ShopifyTransportFailure, Requirements> {
  return resolveSecret(value).pipe(
    Effect.mapError(invalidConfiguration),
    Effect.flatMap((clientSecret) =>
      Redacted.value(clientSecret).length > 0
        ? Effect.succeed(clientSecret)
        : Effect.fail(invalidConfiguration()),
    ),
  )
}

function configuredScopes(
  scopes: readonly [string, ...string[]],
): Effect.Effect<readonly string[], ShopifyTransportFailure> {
  const unique = new Set(scopes)
  return unique.size === scopes.length &&
    scopes.every((scope) => scope.length > 0 && scope.trim() === scope && !scope.includes(','))
    ? Effect.succeed(scopes)
    : Effect.fail(invalidConfiguration())
}

function shopOrigin(shopDomain: string): URL {
  return new URL(`https://${shopDomain}`)
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
    if (actual.length !== 1 || actual[0] !== expected) return false
  }

  const keys = [...new Set(callback.searchParams.keys())]
  for (const name of keys) {
    const values = callback.searchParams.getAll(name)
    if (values.length !== 1 || values[0]?.length === 0) return false
  }

  return requiredCallbackParameters.every((name) => callback.searchParams.getAll(name).length === 1)
}

function callbackHmacMessage(callback: URL): string {
  const parameters = [...callback.searchParams.entries()].filter(([name]) => name !== 'hmac')
  parameters.sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
  return parameters.map(([name, value]) => `${name}=${value}`).join('&')
}

function bytesFromHex(value: string): Uint8Array<ArrayBuffer> | null {
  if (!/^[a-f\d]{64}$/i.test(value)) return null
  const bytes = new Uint8Array(new ArrayBuffer(value.length / 2))
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(value.slice(index * 2, index * 2 + 2), 16)
  }
  return bytes
}

function verifyCallbackHmac(
  callback: URL,
  clientSecret: Redacted.Redacted<string>,
): Effect.Effect<boolean, ShopifyTransportFailure> {
  const hmac = callback.searchParams.get('hmac')
  const signature = hmac === null ? null : bytesFromHex(hmac)
  if (signature === null) return Effect.succeed(false)

  return Effect.tryPromise({
    try: async () => {
      const encoder = new TextEncoder()
      const key = await crypto.subtle.importKey(
        'raw',
        encoder.encode(Redacted.value(clientSecret)),
        { name: 'HMAC', hash: 'SHA-256' },
        false,
        ['verify'],
      )
      return crypto.subtle.verify(
        'HMAC',
        key,
        signature,
        encoder.encode(callbackHmacMessage(callback)),
      )
    },
    catch: invalidCallback,
  })
}

function authorizationUrl<Requirements>(
  configuration: ShopifyOAuthConfiguration<Requirements>,
  input: AuthorizationUrlInput,
): Effect.Effect<string, ShopifyTransportFailure, Requirements> {
  return Effect.all({
    clientId: configuredClientId(configuration.clientId),
    redirectUri: configuredRedirect(configuration.redirectUri),
    scopes: configuredScopes(configuration.scopes),
    shopDomain: configuredShopDomain(configuration.shopDomain),
  }).pipe(
    Effect.map(({ clientId, redirectUri, scopes, shopDomain }) => {
      const destination = new URL(authorizationPath, shopOrigin(shopDomain))
      destination.search = new URLSearchParams({
        client_id: clientId,
        scope: scopes.join(','),
        redirect_uri: redirectUri.toString(),
        state: input.state,
      }).toString()
      return destination.toString()
    }),
  )
}

function parseAuthorizationCallback<Requirements>(
  configuration: ShopifyOAuthConfiguration<Requirements>,
  callbackUrl: string,
): Effect.Effect<AuthorizationCallback, ShopifyTransportFailure, Requirements> {
  return Effect.gen(function* () {
    const redirect = yield* configuredRedirect(configuration.redirectUri)
    const shopDomain = yield* configuredShopDomain(configuration.shopDomain)
    const callback = yield* Effect.try({
      try: () => new URL(callbackUrl),
      catch: invalidCallback,
    })
    if (!callbackMatchesRedirect(callback, redirect)) {
      return yield* Effect.fail(invalidCallback())
    }

    const callbackShop = callback.searchParams.get('shop')
    if (callbackShop !== shopDomain) return yield* Effect.fail(invalidCallback())

    const clientSecret = yield* configuredClientSecret(configuration.clientSecret)
    if (!(yield* verifyCallbackHmac(callback, clientSecret))) {
      return yield* Effect.fail(invalidCallback())
    }

    const code = callback.searchParams.get('code')
    const state = callback.searchParams.get('state')
    if (code === null || state === null) return yield* Effect.fail(invalidCallback())
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
): Effect.Effect<TokenResponse, ShopifyTransportFailure> {
  return Effect.tryPromise({
    try: async (effectSignal) => {
      const controller = new AbortController()
      const abort = () => controller.abort()
      effectSignal.addEventListener('abort', abort, { once: true })
      const timeout = setTimeout(abort, timeoutMilliseconds)
      try {
        const response = await fetch(url, {
          method: 'POST',
          headers: {
            accept: 'application/json',
            'content-type': 'application/x-www-form-urlencoded',
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
    catch: (error) =>
      new ShopifyTransportFailure({
        reason: error instanceof MalformedJsonResponse ? 'MalformedResponse' : 'TransportFailure',
      }),
  })
}

function exchangeAuthorizationCode<Requirements>(
  configuration: ShopifyOAuthConfiguration<Requirements>,
  input: AuthorizationCodeExchangeInput,
): Effect.Effect<ProviderCredentialSet, ShopifyTransportFailure, Requirements> {
  return configuredShopDomain(configuration.shopDomain).pipe(
    Effect.flatMap((shopDomain) =>
      Effect.all({
        clientId: configuredClientId(configuration.clientId),
        clientSecret: configuredClientSecret(configuration.clientSecret),
        scopes: configuredScopes(configuration.scopes),
      }).pipe(
        Effect.flatMap(({ clientId, clientSecret, scopes }) =>
          tokenPost(
            new URL(tokenPath, shopOrigin(shopDomain)),
            new URLSearchParams({
              client_id: clientId,
              client_secret: Redacted.value(clientSecret),
              code: Redacted.value(input.code),
              expiring: '1',
            }),
          ).pipe(
            Effect.flatMap((response) =>
              response._tag === 'HttpFailure'
                ? Effect.fail(new ShopifyTransportFailure({ reason: 'ProviderRejected' }))
                : parseTokenResponse(response.body, shopDomain, scopes, input.now),
            ),
          ),
        ),
      ),
    ),
  )
}

function refreshTokenPost(
  url: URL,
  body: URLSearchParams,
  shopDomain: string,
  scopes: readonly string[],
  now: number,
  attemptsRemaining = maximumRefreshAttempts,
): Effect.Effect<ProviderRefreshOutcome> {
  return tokenPost(url, body).pipe(
    Effect.matchEffect({
      onFailure: (failure) =>
        failure.reason === 'TransportFailure' && attemptsRemaining > 1
          ? refreshTokenPost(url, body, shopDomain, scopes, now, attemptsRemaining - 1)
          : Effect.succeed<ProviderRefreshOutcome>(
              failure.reason === 'TransportFailure'
                ? { _tag: 'ProviderOutcomeUnknown' }
                : { _tag: 'ProviderFailure' },
            ),
      onSuccess: (response): Effect.Effect<ProviderRefreshOutcome> => {
        if (response._tag === 'Success') {
          return parseTokenResponse(response.body, shopDomain, scopes, now).pipe(
            Effect.match({
              onFailure: (): ProviderRefreshOutcome => ({ _tag: 'ProviderFailure' }),
              onSuccess: (credentials): ProviderRefreshOutcome => ({
                _tag: 'Refreshed',
                credentials,
              }),
            }),
          )
        }
        if (response.status === 401) return Effect.succeed({ _tag: 'ProviderRejected' })
        if (response.status !== 429 && response.status < 500) {
          return Effect.succeed({ _tag: 'ProviderFailure' })
        }
        return attemptsRemaining > 1
          ? refreshTokenPost(url, body, shopDomain, scopes, now, attemptsRemaining - 1)
          : Effect.succeed({ _tag: 'ProviderOutcomeUnknown' })
      },
    }),
  )
}

function refreshCredentials<Requirements>(
  configuration: ShopifyOAuthConfiguration<Requirements>,
  input: RefreshCredentialInput,
): Effect.Effect<ProviderRefreshOutcome, never, Requirements> {
  const previous = parseStoredCredentials(Redacted.value(input.protectedPayload))
  if (previous === null || !Number.isFinite(input.now) || input.now < 0) {
    return Effect.succeed({ _tag: 'ProviderFailure' })
  }
  if (previous.refreshTokenExpiresAt <= input.now) {
    return Effect.succeed({ _tag: 'ProviderRejected' })
  }

  return configuredShopDomain(configuration.shopDomain).pipe(
    Effect.flatMap((shopDomain) => {
      if (previous.shopDomain !== shopDomain) {
        return Effect.fail(new ShopifyTransportFailure({ reason: 'InvalidStoredCredentials' }))
      }
      return Effect.all({
        clientId: configuredClientId(configuration.clientId),
        clientSecret: configuredClientSecret(configuration.clientSecret),
        scopes: configuredScopes(configuration.scopes),
      }).pipe(
        Effect.flatMap(({ clientId, clientSecret, scopes }) =>
          refreshTokenPost(
            new URL(tokenPath, shopOrigin(shopDomain)),
            new URLSearchParams({
              grant_type: 'refresh_token',
              client_id: clientId,
              client_secret: Redacted.value(clientSecret),
              refresh_token: previous.refreshToken,
            }),
            shopDomain,
            scopes,
            input.now,
          ),
        ),
      )
    }),
    Effect.matchEffect({
      onFailure: () => Effect.succeed({ _tag: 'ProviderFailure' as const }),
      onSuccess: Effect.succeed,
    }),
  )
}

export function makeShopifyTransport<Requirements>(
  configuration: ShopifyOAuthConfiguration<Requirements>,
): Pick<
  OAuthProviderDefinition<ShopifyCredentials, Requirements>,
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
    projectCredentials: (protectedPayload) =>
      configuredShopDomain(configuration.shopDomain).pipe(
        Effect.flatMap((shopDomain) => projectCredentials(protectedPayload, shopDomain)),
      ),
  }
}
