import { Effect, Redacted } from 'effect'
import type {
  PreparedClientCredentials,
  ProviderCredentialSet,
} from '../../core/contracts/provider.js'
import {
  parseInstanceUrl,
  responseExpiry,
  SalesforceTransportFailure,
  type SalesforceCredentials,
} from './responses.js'

export interface SalesforceSourceCredentials {
  readonly clientId: string
  readonly clientSecret: string | Redacted.Redacted<string>
}

export interface StoredSalesforceClientCredentials {
  readonly schemaVersion: 1
  readonly clientId: string
  readonly clientSecret: string
  readonly accessToken?: string
  readonly instanceUrl?: string
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null
}

export function prepareClientCredentials(
  source: SalesforceSourceCredentials,
): Effect.Effect<PreparedClientCredentials, SalesforceTransportFailure> {
  return Effect.try({
    try: () => {
      const clientId = nonEmptyString(source.clientId)
      const clientSecret = nonEmptyString(
        typeof source.clientSecret === 'string'
          ? source.clientSecret
          : Redacted.value(source.clientSecret),
      )
      if (clientId === null || clientSecret === null) throw new TypeError('Invalid source')
      const stored: StoredSalesforceClientCredentials = { schemaVersion: 1, clientId, clientSecret }
      return { protectedPayload: Redacted.make(JSON.stringify(stored)) }
    },
    catch: () => new SalesforceTransportFailure({ reason: 'InvalidConfiguration' }),
  })
}

export function parseStoredCredentials(value: string): StoredSalesforceClientCredentials | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(value)
  } catch {
    return null
  }
  if (typeof parsed !== 'object' || parsed === null) return null
  const clientId = nonEmptyString(Reflect.get(parsed, 'clientId'))
  const clientSecret = nonEmptyString(Reflect.get(parsed, 'clientSecret'))
  const rawToken = Reflect.get(parsed, 'accessToken')
  const rawInstance = Reflect.get(parsed, 'instanceUrl')
  if (Reflect.get(parsed, 'schemaVersion') !== 1 || clientId === null || clientSecret === null)
    return null
  if (rawToken === undefined && rawInstance === undefined)
    return { schemaVersion: 1, clientId, clientSecret }
  const accessToken = nonEmptyString(rawToken)
  const instanceUrl = parseInstanceUrl(rawInstance)
  return accessToken === null || instanceUrl === null
    ? null
    : { schemaVersion: 1, clientId, clientSecret, accessToken, instanceUrl }
}

export function parseTokenResponse(
  response: unknown,
  previous: StoredSalesforceClientCredentials,
  now: number,
): Effect.Effect<ProviderCredentialSet, SalesforceTransportFailure> {
  if (typeof response !== 'object' || response === null)
    return Effect.fail(new SalesforceTransportFailure({ reason: 'MalformedResponse' }))
  const accessToken = nonEmptyString(Reflect.get(response, 'access_token'))
  const instanceUrl = parseInstanceUrl(Reflect.get(response, 'instance_url'))
  const tokenType = nonEmptyString(Reflect.get(response, 'token_type'))
  const credentialExpiresAt = responseExpiry(response, now)
  if (
    accessToken === null ||
    instanceUrl === null ||
    tokenType?.toLowerCase() !== 'bearer' ||
    credentialExpiresAt === undefined
  )
    return Effect.fail(new SalesforceTransportFailure({ reason: 'MalformedResponse' }))
  return Effect.succeed({
    protectedPayload: Redacted.make(JSON.stringify({ ...previous, accessToken, instanceUrl })),
    credentialExpiresAt,
  })
}

export function projectCredentials(
  payload: Redacted.Redacted<string>,
): Effect.Effect<SalesforceCredentials, SalesforceTransportFailure> {
  const stored = parseStoredCredentials(Redacted.value(payload))
  return stored === null || stored.accessToken === undefined || stored.instanceUrl === undefined
    ? Effect.fail(new SalesforceTransportFailure({ reason: 'InvalidStoredCredentials' }))
    : Effect.succeed({
        accessToken: Redacted.make(stored.accessToken),
        instanceUrl: stored.instanceUrl,
      })
}
