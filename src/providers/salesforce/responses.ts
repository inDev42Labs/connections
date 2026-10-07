import { Data, Effect, Redacted } from 'effect'
import type { ProviderCredentialSet } from '../../core/contracts/provider.js'

export interface SalesforceCredentials {
  readonly accessToken: Redacted.Redacted<string>
  readonly instanceUrl: string
}

export class SalesforceTransportFailure extends Data.TaggedError('SalesforceTransportFailure')<{
  readonly reason:
    | 'InvalidConfiguration'
    | 'InvalidCallback'
    | 'ProviderRejected'
    | 'TransportFailure'
    | 'MalformedResponse'
    | 'InvalidStoredCredentials'
}> {}

export interface StoredSalesforceCredentials {
  readonly accessToken: string
  readonly refreshToken: string
  readonly instanceUrl: string
  readonly credentialExpiresAt: number | null
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null
}

export function parseInstanceUrl(value: unknown): string | null {
  const text = nonEmptyString(value)
  if (text === null) return null
  try {
    const url = new URL(text)
    return url.protocol === 'https:' && url.username === '' && url.password === ''
      ? url.origin
      : null
  } catch {
    return null
  }
}

function finiteNumericField(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  if (typeof value !== 'string' || !/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:e[+-]?\d+)?$/i.test(value)) {
    return null
  }
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : null
}

export function responseExpiry(response: object, now: number): number | null | undefined {
  const rawIssuedAt = Reflect.get(response, 'issued_at')
  const issuedAt = rawIssuedAt === undefined ? now : finiteNumericField(rawIssuedAt)
  if (issuedAt === null || !Number.isFinite(issuedAt) || issuedAt < 0) return undefined

  const rawExpiresIn = Reflect.get(response, 'expires_in')
  if (rawExpiresIn === undefined) return null
  const expiresIn = finiteNumericField(rawExpiresIn)
  if (expiresIn === null || !Number.isFinite(expiresIn) || expiresIn <= 0) return undefined

  const expiresAt = issuedAt + expiresIn * 1000
  return Number.isFinite(expiresAt) ? expiresAt : undefined
}

export function parseAuthorizationCodeResponse(
  response: unknown,
  now: number,
): Effect.Effect<ProviderCredentialSet, SalesforceTransportFailure> {
  if (typeof response !== 'object' || response === null) {
    return Effect.fail(new SalesforceTransportFailure({ reason: 'MalformedResponse' }))
  }
  const accessToken = nonEmptyString(Reflect.get(response, 'access_token'))
  const refreshToken = nonEmptyString(Reflect.get(response, 'refresh_token'))
  const instanceUrl = parseInstanceUrl(Reflect.get(response, 'instance_url'))
  const tokenType = nonEmptyString(Reflect.get(response, 'token_type'))
  if (
    accessToken === null ||
    refreshToken === null ||
    instanceUrl === null ||
    tokenType?.toLowerCase() !== 'bearer'
  ) {
    return Effect.fail(new SalesforceTransportFailure({ reason: 'MalformedResponse' }))
  }
  const credentialExpiresAt = responseExpiry(response, now)
  if (credentialExpiresAt === undefined) {
    return Effect.fail(new SalesforceTransportFailure({ reason: 'MalformedResponse' }))
  }
  const stored: StoredSalesforceCredentials = {
    accessToken,
    refreshToken,
    instanceUrl,
    credentialExpiresAt,
  }
  return Effect.succeed({
    protectedPayload: Redacted.make(JSON.stringify(stored)),
    credentialExpiresAt,
  })
}

export function parseStoredCredentials(value: string): StoredSalesforceCredentials | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(value)
  } catch {
    return null
  }
  if (typeof parsed !== 'object' || parsed === null) return null
  const accessToken = nonEmptyString(Reflect.get(parsed, 'accessToken'))
  const refreshToken = nonEmptyString(Reflect.get(parsed, 'refreshToken'))
  const instanceUrl = parseInstanceUrl(Reflect.get(parsed, 'instanceUrl'))
  const rawExpiry = Reflect.get(parsed, 'credentialExpiresAt')
  const credentialExpiresAt =
    rawExpiry === null
      ? null
      : typeof rawExpiry === 'number' && Number.isFinite(rawExpiry)
        ? rawExpiry
        : undefined
  if (
    accessToken === null ||
    refreshToken === null ||
    instanceUrl === null ||
    credentialExpiresAt === undefined
  ) {
    return null
  }
  return { accessToken, refreshToken, instanceUrl, credentialExpiresAt }
}

export function parseRefreshResponse(
  response: unknown,
  previous: StoredSalesforceCredentials,
  now: number,
): Effect.Effect<ProviderCredentialSet, SalesforceTransportFailure> {
  if (typeof response !== 'object' || response === null) {
    return Effect.fail(new SalesforceTransportFailure({ reason: 'MalformedResponse' }))
  }
  const accessToken = nonEmptyString(Reflect.get(response, 'access_token'))
  const instanceUrl = parseInstanceUrl(Reflect.get(response, 'instance_url'))
  const tokenType = nonEmptyString(Reflect.get(response, 'token_type'))
  const rawRefreshToken = Reflect.get(response, 'refresh_token')
  const refreshToken =
    rawRefreshToken === undefined ? previous.refreshToken : nonEmptyString(rawRefreshToken)
  if (
    accessToken === null ||
    refreshToken === null ||
    instanceUrl === null ||
    tokenType?.toLowerCase() !== 'bearer'
  ) {
    return Effect.fail(new SalesforceTransportFailure({ reason: 'MalformedResponse' }))
  }
  const credentialExpiresAt = responseExpiry(response, now)
  if (credentialExpiresAt === undefined) {
    return Effect.fail(new SalesforceTransportFailure({ reason: 'MalformedResponse' }))
  }
  const stored: StoredSalesforceCredentials = {
    accessToken,
    refreshToken,
    instanceUrl,
    credentialExpiresAt,
  }
  return Effect.succeed({
    protectedPayload: Redacted.make(JSON.stringify(stored)),
    credentialExpiresAt,
  })
}

export function projectCredentials(
  protectedPayload: Redacted.Redacted<string>,
): Effect.Effect<SalesforceCredentials, SalesforceTransportFailure> {
  const stored = parseStoredCredentials(Redacted.value(protectedPayload))
  return stored === null
    ? Effect.fail(new SalesforceTransportFailure({ reason: 'InvalidStoredCredentials' }))
    : Effect.succeed({
        accessToken: Redacted.make(stored.accessToken),
        instanceUrl: stored.instanceUrl,
      })
}
