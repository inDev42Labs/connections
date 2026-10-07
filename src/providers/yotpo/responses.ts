import { Data, Effect, Redacted } from 'effect'
import type {
  PreparedClientCredentials,
  ProviderCredentialSet,
} from '../../core/contracts/provider.js'

export interface YotpoCredentials {
  readonly accessToken: Redacted.Redacted<string>
  readonly storeId: string
}

export interface YotpoSourceCredentials {
  readonly storeId: string
  readonly apiSecret: string | Redacted.Redacted<string>
}

export class YotpoTransportFailure extends Data.TaggedError('YotpoTransportFailure')<{
  readonly reason: 'InvalidConfiguration' | 'MalformedResponse' | 'InvalidStoredCredentials'
}> {}

interface StoredYotpoCredentials {
  readonly schemaVersion: 1
  readonly storeId: string
  readonly apiSecret: string
  readonly accessToken?: string
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null
}

function failure(reason: YotpoTransportFailure['reason']): YotpoTransportFailure {
  return new YotpoTransportFailure({ reason })
}

function parseStored(value: string): StoredYotpoCredentials | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(value)
  } catch {
    return null
  }
  if (typeof parsed !== 'object' || parsed === null) return null

  const schemaVersion = Reflect.get(parsed, 'schemaVersion')
  const storeId = nonEmptyString(Reflect.get(parsed, 'storeId'))
  const apiSecret = nonEmptyString(Reflect.get(parsed, 'apiSecret'))
  const accessTokenValue = Reflect.get(parsed, 'accessToken')
  const accessToken = accessTokenValue === undefined ? undefined : nonEmptyString(accessTokenValue)
  if (
    schemaVersion !== 1 ||
    storeId === null ||
    apiSecret === null ||
    (accessTokenValue !== undefined && accessToken === null)
  ) {
    return null
  }
  if (accessToken === undefined) return { schemaVersion, storeId, apiSecret }
  if (accessToken === null) return null
  return { schemaVersion, storeId, apiSecret, accessToken }
}

export function prepareClientCredentials(
  credentials: YotpoSourceCredentials,
): Effect.Effect<PreparedClientCredentials, YotpoTransportFailure> {
  const storeId = nonEmptyString(credentials.storeId)
  const apiSecret = nonEmptyString(
    typeof credentials.apiSecret === 'string'
      ? credentials.apiSecret
      : Redacted.value(credentials.apiSecret),
  )
  if (storeId === null || apiSecret === null) {
    return Effect.fail(failure('InvalidConfiguration'))
  }
  const stored: StoredYotpoCredentials = { schemaVersion: 1, storeId, apiSecret }
  return Effect.succeed({
    protectedPayload: Redacted.make(JSON.stringify(stored)),
  })
}

export function parseStoredCredentials(value: string): StoredYotpoCredentials | null {
  return parseStored(value)
}

export function parseTokenResponse(
  response: unknown,
  previous: StoredYotpoCredentials,
): Effect.Effect<ProviderCredentialSet, YotpoTransportFailure> {
  if (typeof response !== 'object' || response === null) {
    return Effect.fail(failure('MalformedResponse'))
  }
  const accessToken = nonEmptyString(Reflect.get(response, 'access_token'))
  const tokenType = nonEmptyString(Reflect.get(response, 'token_type'))
  if (accessToken === null || tokenType === null) {
    return Effect.fail(failure('MalformedResponse'))
  }
  const stored: StoredYotpoCredentials = { ...previous, accessToken }
  return Effect.succeed({
    protectedPayload: Redacted.make(JSON.stringify(stored)),
    credentialExpiresAt: null,
  })
}

export function projectCredentials(
  protectedPayload: Redacted.Redacted<string>,
): Effect.Effect<YotpoCredentials, YotpoTransportFailure> {
  const stored = parseStored(Redacted.value(protectedPayload))
  return stored === null || stored.accessToken === undefined
    ? Effect.fail(failure('InvalidStoredCredentials'))
    : Effect.succeed({
        accessToken: Redacted.make(stored.accessToken),
        storeId: stored.storeId,
      })
}
