import { Effect, Redacted } from 'effect'
import { makeControlledCheckpoint, type ControlledCheckpoint } from './lifecycle-driver.js'
import type {
  ClientCredentialsProviderDefinition,
  ProviderClientCredentialsOutcome,
  ProviderCredentialSet,
} from '../../src/core/contracts/provider.js'

export interface DeterministicClientCredentialsSource {
  readonly source: Redacted.Redacted<string>
}
export interface DeterministicClientCredentials {
  readonly token: Redacted.Redacted<string>
}
export interface DeterministicClientCredentialsProvider {
  readonly provider: ClientCredentialsProviderDefinition<
    DeterministicClientCredentialsSource,
    DeterministicClientCredentials
  >
  readonly requests: () => number
  readonly acquiredSources: () => readonly string[]
  readonly issue: (token: string, expiresAt?: number | null) => void
  readonly rejectNext: () => void
  readonly failNext: () => void
  readonly outcomeUnknownNext: () => void
  readonly pauseNextAcquisition: () => ControlledCheckpoint<true>
}

export function makeDeterministicClientCredentialsProvider(): DeterministicClientCredentialsProvider {
  let requests = 0
  const acquiredSources: string[] = []
  let next: { readonly token: string; readonly expiresAt: number | null } = {
    token: 'token-1',
    expiresAt: null,
  }
  let nextOutcome: ProviderClientCredentialsOutcome | null = null
  let nextAcquisitionCheckpoint: ControlledCheckpoint<true> | null = null
  const encode = (source: string, token: string | null) =>
    Redacted.make(JSON.stringify({ version: 1, source, token }))
  const decode = (payload: Redacted.Redacted<string>) => {
    const value: unknown = JSON.parse(Redacted.value(payload))
    if (typeof value !== 'object' || value === null) throw new TypeError('invalid payload')
    const candidate = value as { source?: unknown; token?: unknown }
    if (
      typeof candidate.source !== 'string' ||
      (candidate.token !== null && typeof candidate.token !== 'string')
    )
      throw new TypeError('invalid payload')
    return { source: candidate.source, token: candidate.token }
  }
  return {
    requests: () => requests,
    acquiredSources: () => [...acquiredSources],
    issue: (token, expiresAt = null) => {
      next = { token, expiresAt }
    },
    rejectNext: () => {
      nextOutcome = { _tag: 'ProviderRejected' }
    },
    failNext: () => {
      nextOutcome = { _tag: 'ProviderFailure' }
    },
    outcomeUnknownNext: () => {
      nextOutcome = { _tag: 'ProviderOutcomeUnknown' }
    },
    pauseNextAcquisition: () => {
      const checkpoint = makeControlledCheckpoint(true)
      nextAcquisitionCheckpoint = checkpoint
      return checkpoint
    },
    provider: {
      id: 'deterministic-client-credentials',
      prepareClientCredentials: (credentials) => {
        const source = Redacted.value(credentials.source)
        return source.length === 0
          ? Effect.fail(new Error('empty source'))
          : Effect.succeed({ protectedPayload: encode(source, null) })
      },
      acquireCredentials: ({ protectedPayload }): Effect.Effect<ProviderClientCredentialsOutcome> =>
        Effect.gen(function* () {
          const source = decode(protectedPayload)
          const checkpoint = nextAcquisitionCheckpoint
          nextAcquisitionCheckpoint = null
          requests++
          acquiredSources.push(source.source)
          if (checkpoint !== null) yield* checkpoint.at(true)
          const outcome = nextOutcome
          nextOutcome = null
          if (outcome !== null) return outcome
          return {
            _tag: 'Acquired' as const,
            credentials: {
              protectedPayload: encode(source.source, next.token),
              credentialExpiresAt: next.expiresAt,
            } satisfies ProviderCredentialSet,
          }
        }),
      projectCredentials: (protectedPayload) =>
        Effect.sync(() => {
          const decoded = decode(protectedPayload)
          if (decoded.token === null) throw new Error('derived credential unavailable')
          return { token: Redacted.make(decoded.token) }
        }),
    },
  }
}
