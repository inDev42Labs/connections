import { Data, Effect, Redacted } from 'effect'
import type { ProviderCredentialSet } from '../../core/contracts/provider.js'

export interface ShopifyCredentials {
  readonly accessToken: Redacted.Redacted<string>
  readonly shopDomain: string
}

export class ShopifyTransportFailure extends Data.TaggedError('ShopifyTransportFailure')<{
  readonly reason:
    | 'InvalidConfiguration'
    | 'InvalidCallback'
    | 'ProviderRejected'
    | 'TransportFailure'
    | 'MalformedResponse'
    | 'InvalidStoredCredentials'
}> {}

export interface StoredShopifyCredentials {
  readonly schemaVersion: 1
  readonly accessToken: string
  readonly refreshToken: string
  readonly shopDomain: string
  readonly credentialExpiresAt: number
  readonly refreshTokenExpiresAt: number
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null
}

function positiveFiniteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null
}

export function parseShopDomain(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const suffix = '.myshopify.com'
  if (!value.endsWith(suffix)) return null
  const label = value.slice(0, -suffix.length)
  return label.length <= 63 && /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label) ? value : null
}

function parseGrantedScopes(value: unknown): readonly string[] | null {
  const text = nonEmptyString(value)
  if (text === null) return null
  const scopes = text.split(',')
  return scopes.every((scope) => scope.length > 0 && scope.trim() === scope) ? scopes : null
}

function grantsRequestedScopes(granted: readonly string[], requested: readonly string[]): boolean {
  const available = new Set(granted)
  return requested.every(
    (scope) =>
      available.has(scope) ||
      (scope.startsWith('read_') && available.has(`write_${scope.slice('read_'.length)}`)),
  )
}

function expiresAt(now: number, seconds: unknown): number | null {
  const duration = positiveFiniteNumber(seconds)
  if (!Number.isFinite(now) || now < 0 || duration === null) return null
  const value = now + duration * 1_000
  return Number.isFinite(value) ? value : null
}

export function parseTokenResponse(
  response: unknown,
  shopDomain: string,
  requestedScopes: readonly string[],
  now: number,
): Effect.Effect<ProviderCredentialSet, ShopifyTransportFailure> {
  if (typeof response !== 'object' || response === null) {
    return Effect.fail(new ShopifyTransportFailure({ reason: 'MalformedResponse' }))
  }

  const accessToken = nonEmptyString(Reflect.get(response, 'access_token'))
  const refreshToken = nonEmptyString(Reflect.get(response, 'refresh_token'))
  const grantedScopes = parseGrantedScopes(Reflect.get(response, 'scope'))
  const credentialExpiresAt = expiresAt(now, Reflect.get(response, 'expires_in'))
  const refreshTokenExpiresAt = expiresAt(now, Reflect.get(response, 'refresh_token_expires_in'))
  if (
    accessToken === null ||
    refreshToken === null ||
    grantedScopes === null ||
    !grantsRequestedScopes(grantedScopes, requestedScopes) ||
    credentialExpiresAt === null ||
    refreshTokenExpiresAt === null
  ) {
    return Effect.fail(new ShopifyTransportFailure({ reason: 'MalformedResponse' }))
  }

  const stored: StoredShopifyCredentials = {
    schemaVersion: 1,
    accessToken,
    refreshToken,
    shopDomain,
    credentialExpiresAt,
    refreshTokenExpiresAt,
  }
  return Effect.succeed({
    protectedPayload: Redacted.make(JSON.stringify(stored)),
    credentialExpiresAt,
  })
}

export function parseStoredCredentials(value: string): StoredShopifyCredentials | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(value)
  } catch {
    return null
  }
  if (typeof parsed !== 'object' || parsed === null) return null

  const schemaVersion = Reflect.get(parsed, 'schemaVersion')
  const accessToken = nonEmptyString(Reflect.get(parsed, 'accessToken'))
  const refreshToken = nonEmptyString(Reflect.get(parsed, 'refreshToken'))
  const shopDomain = parseShopDomain(Reflect.get(parsed, 'shopDomain'))
  const credentialExpiresAt = positiveFiniteNumber(Reflect.get(parsed, 'credentialExpiresAt'))
  const refreshTokenExpiresAt = positiveFiniteNumber(Reflect.get(parsed, 'refreshTokenExpiresAt'))
  if (
    schemaVersion !== 1 ||
    accessToken === null ||
    refreshToken === null ||
    shopDomain === null ||
    credentialExpiresAt === null ||
    refreshTokenExpiresAt === null
  ) {
    return null
  }

  return {
    schemaVersion,
    accessToken,
    refreshToken,
    shopDomain,
    credentialExpiresAt,
    refreshTokenExpiresAt,
  }
}

export function projectCredentials(
  protectedPayload: Redacted.Redacted<string>,
  expectedShopDomain: string,
): Effect.Effect<ShopifyCredentials, ShopifyTransportFailure> {
  const stored = parseStoredCredentials(Redacted.value(protectedPayload))
  return stored === null || stored.shopDomain !== expectedShopDomain
    ? Effect.fail(new ShopifyTransportFailure({ reason: 'InvalidStoredCredentials' }))
    : Effect.succeed({
        accessToken: Redacted.make(stored.accessToken),
        shopDomain: stored.shopDomain,
      })
}
