import { Data, Effect, Redacted } from 'effect'
import type { ProviderCredentialSet } from '../../core/contracts/provider.js'

export interface ZohoCredentials {
  readonly accessToken: Redacted.Redacted<string>
  readonly apiDomain: string
}

export class ZohoTransportFailure extends Data.TaggedError('ZohoTransportFailure')<{
  readonly reason:
    | 'InvalidConfiguration'
    | 'InvalidCallback'
    | 'ProviderRejected'
    | 'TransportFailure'
    | 'MalformedResponse'
    | 'InvalidStoredCredentials'
}> {}

export interface StoredZohoCredentials {
  readonly accessToken: string
  readonly refreshToken: string
  readonly apiDomain: string
  readonly credentialExpiresAt: number
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null
}

function parseApiDomain(value: unknown): string | null {
  const text = nonEmptyString(value)
  if (text === null) return null
  try {
    const url = new URL(text)
    return url.protocol === 'https:' &&
      url.username === '' &&
      url.password === '' &&
      url.pathname === '/' &&
      url.search === '' &&
      url.hash === ''
      ? url.origin
      : null
  } catch {
    return null
  }
}

function positiveFiniteNumber(value: unknown): number | null {
  if (typeof value === 'number') {
    return Number.isFinite(value) && value > 0 ? value : null
  }
  if (typeof value !== 'string' || !/^(?:0|[1-9]\d*)(?:\.\d+)?(?:e[+-]?\d+)?$/i.test(value)) {
    return null
  }
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null
}

function responseExpiry(response: object, now: number): number | null {
  const expiresIn = positiveFiniteNumber(Reflect.get(response, 'expires_in'))
  if (expiresIn === null || !Number.isFinite(now) || now < 0) return null
  const expiresAt = now + expiresIn * 1_000
  return Number.isFinite(expiresAt) ? expiresAt : null
}

function parseResponse(
  response: unknown,
  refreshToken: string | null,
  now: number,
): Effect.Effect<ProviderCredentialSet, ZohoTransportFailure> {
  if (typeof response !== 'object' || response === null) {
    return Effect.fail(new ZohoTransportFailure({ reason: 'MalformedResponse' }))
  }
  const accessToken = nonEmptyString(Reflect.get(response, 'access_token'))
  const apiDomain = parseApiDomain(Reflect.get(response, 'api_domain'))
  const tokenType = nonEmptyString(Reflect.get(response, 'token_type'))
  const responseRefreshToken = Reflect.get(response, 'refresh_token')
  const resolvedRefreshToken =
    responseRefreshToken === undefined ? refreshToken : nonEmptyString(responseRefreshToken)
  const credentialExpiresAt = responseExpiry(response, now)
  if (
    accessToken === null ||
    resolvedRefreshToken === null ||
    apiDomain === null ||
    tokenType?.toLowerCase() !== 'bearer' ||
    credentialExpiresAt === null
  ) {
    return Effect.fail(new ZohoTransportFailure({ reason: 'MalformedResponse' }))
  }
  const stored: StoredZohoCredentials = {
    accessToken,
    refreshToken: resolvedRefreshToken,
    apiDomain,
    credentialExpiresAt,
  }
  return Effect.succeed({
    protectedPayload: Redacted.make(JSON.stringify(stored)),
    credentialExpiresAt,
  })
}

export function parseAuthorizationCodeResponse(
  response: unknown,
  now: number,
): Effect.Effect<ProviderCredentialSet, ZohoTransportFailure> {
  return parseResponse(response, null, now)
}

export function parseStoredCredentials(value: string): StoredZohoCredentials | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(value)
  } catch {
    return null
  }
  if (typeof parsed !== 'object' || parsed === null) return null
  const accessToken = nonEmptyString(Reflect.get(parsed, 'accessToken'))
  const refreshToken = nonEmptyString(Reflect.get(parsed, 'refreshToken'))
  const apiDomain = parseApiDomain(Reflect.get(parsed, 'apiDomain'))
  const credentialExpiresAt = Reflect.get(parsed, 'credentialExpiresAt')
  if (
    accessToken === null ||
    refreshToken === null ||
    apiDomain === null ||
    typeof credentialExpiresAt !== 'number' ||
    !Number.isFinite(credentialExpiresAt)
  ) {
    return null
  }
  return { accessToken, refreshToken, apiDomain, credentialExpiresAt }
}

export function parseRefreshResponse(
  response: unknown,
  previous: StoredZohoCredentials,
  now: number,
): Effect.Effect<ProviderCredentialSet, ZohoTransportFailure> {
  return parseResponse(response, previous.refreshToken, now)
}

export function projectCredentials(
  protectedPayload: Redacted.Redacted<string>,
): Effect.Effect<ZohoCredentials, ZohoTransportFailure> {
  const stored = parseStoredCredentials(Redacted.value(protectedPayload))
  return stored === null
    ? Effect.fail(new ZohoTransportFailure({ reason: 'InvalidStoredCredentials' }))
    : Effect.succeed({
        accessToken: Redacted.make(stored.accessToken),
        apiDomain: stored.apiDomain,
      })
}
