import { Data, Effect, Redacted } from 'effect'
import type { ProviderCredentialSet } from '../../core/contracts/provider.js'

export interface AmazonCredentials {
  readonly accessToken: Redacted.Redacted<string>
}

export class AmazonTransportFailure extends Data.TaggedError('AmazonTransportFailure')<{
  readonly reason:
    | 'InvalidConfiguration'
    | 'InvalidCallback'
    | 'ProviderRejected'
    | 'TransportFailure'
    | 'MalformedResponse'
    | 'InvalidStoredCredentials'
}> {}

interface StoredAmazonCredentials {
  readonly accessToken: string
  readonly refreshToken: string
  readonly credentialExpiresAt: number
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0
}

export function parseTokenResponse(
  response: unknown,
  now: number,
  previousRefreshToken?: string,
): Effect.Effect<ProviderCredentialSet, AmazonTransportFailure> {
  if (typeof response !== 'object' || response === null) {
    return Effect.fail(new AmazonTransportFailure({ reason: 'MalformedResponse' }))
  }
  const accessToken: unknown = Reflect.get(response, 'access_token')
  const rawRefreshToken: unknown = Reflect.get(response, 'refresh_token')
  const refreshToken = rawRefreshToken === undefined ? previousRefreshToken : rawRefreshToken
  const tokenType: unknown = Reflect.get(response, 'token_type')
  const expiresIn: unknown = Reflect.get(response, 'expires_in')
  if (
    !nonEmptyString(accessToken) ||
    !nonEmptyString(refreshToken) ||
    typeof tokenType !== 'string' ||
    tokenType.toLowerCase() !== 'bearer' ||
    typeof expiresIn !== 'number' ||
    !Number.isFinite(expiresIn) ||
    expiresIn <= 0 ||
    !Number.isFinite(now + expiresIn * 1000)
  ) {
    return Effect.fail(new AmazonTransportFailure({ reason: 'MalformedResponse' }))
  }
  const stored: StoredAmazonCredentials = {
    accessToken,
    refreshToken,
    credentialExpiresAt: now + expiresIn * 1000,
  }
  return Effect.succeed({
    protectedPayload: Redacted.make(JSON.stringify(stored)),
    credentialExpiresAt: stored.credentialExpiresAt,
  })
}

export function parseStoredCredentials(value: string): StoredAmazonCredentials | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(value)
  } catch {
    return null
  }
  if (typeof parsed !== 'object' || parsed === null) return null
  const accessToken: unknown = Reflect.get(parsed, 'accessToken')
  const refreshToken: unknown = Reflect.get(parsed, 'refreshToken')
  const credentialExpiresAt: unknown = Reflect.get(parsed, 'credentialExpiresAt')
  if (
    !nonEmptyString(accessToken) ||
    !nonEmptyString(refreshToken) ||
    typeof credentialExpiresAt !== 'number' ||
    !Number.isFinite(credentialExpiresAt)
  ) {
    return null
  }
  return { accessToken, refreshToken, credentialExpiresAt }
}

export function projectCredentials(
  protectedPayload: Redacted.Redacted<string>,
): Effect.Effect<AmazonCredentials, AmazonTransportFailure> {
  const stored = parseStoredCredentials(Redacted.value(protectedPayload))
  return stored === null
    ? Effect.fail(new AmazonTransportFailure({ reason: 'InvalidStoredCredentials' }))
    : Effect.succeed({ accessToken: Redacted.make(stored.accessToken) })
}
