import { Effect, Redacted } from 'effect'
import type { ApiKeyProviderDefinition } from '../../core/contracts/provider.js'

export interface ApiKeyCredentials {
  readonly apiKey: Redacted.Redacted<string>
}

export interface OpaqueApiKeyOptions<Id extends string> {
  /** Stable identifier persisted with connections. Changing it requires reenrollment. */
  readonly id: Id
}

export interface OpaqueApiKey<
  Id extends string,
> extends ApiKeyProviderDefinition<ApiKeyCredentials> {
  readonly id: Id
}

interface StoredApiKey {
  readonly schemaVersion: 1
  readonly apiKey: string
}

function parseStoredApiKey(protectedPayload: Redacted.Redacted<string>): StoredApiKey {
  const parsed = JSON.parse(Redacted.value(protectedPayload)) as unknown
  if (typeof parsed !== 'object' || parsed === null) {
    throw new TypeError('Invalid stored API key')
  }
  const schemaVersion = Reflect.get(parsed, 'schemaVersion')
  const apiKey = Reflect.get(parsed, 'apiKey')
  if (schemaVersion !== 1 || typeof apiKey !== 'string' || apiKey === '') {
    throw new TypeError('Invalid stored API key')
  }
  return { schemaVersion, apiKey }
}

export function opaque<const Id extends string>(
  options: OpaqueApiKeyOptions<Id>,
): OpaqueApiKey<Id> {
  if (options.id.length === 0) throw new TypeError('API-key provider id must not be empty')

  return Object.freeze({
    id: options.id,
    prepareApiKey: (value: Redacted.Redacted<string>) =>
      Effect.try({
        try: () => {
          const apiKey = Redacted.value(value)
          if (apiKey === '') throw new TypeError('API keys must not be empty')
          return {
            protectedPayload: Redacted.make(
              JSON.stringify({ schemaVersion: 1, apiKey } satisfies StoredApiKey),
            ),
            credentialExpiresAt: null,
          }
        },
        catch: () => new TypeError('Invalid API key'),
      }),
    projectCredentials: (protectedPayload: Redacted.Redacted<string>) =>
      Effect.try({
        try: () => ({
          apiKey: Redacted.make(parseStoredApiKey(protectedPayload).apiKey),
        }),
        catch: () => new TypeError('Invalid stored API key'),
      }),
  })
}
