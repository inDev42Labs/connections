// THROWAWAY EXPERIMENT — not exported by the package.
// No real OAuth, SQL, encryption, leases, or production recovery protocol.
import { randomUUID } from 'node:crypto'
import { Clock, Context, Data, Effect } from 'effect'
import type { Redacted } from 'effect'

export interface Tokens {
  readonly accessToken: Redacted.Redacted<string>
  readonly refreshToken: Redacted.Redacted<string>
  readonly expiresAt: number
  readonly refreshTokenExpiresAt?: number
}

// A reusable-token provider can omit refresh credentials from its response.
export interface RefreshResponse {
  readonly accessToken: Redacted.Redacted<string>
  readonly expiresAt: number
  readonly refreshToken?: Redacted.Redacted<string>
  readonly refreshTokenExpiresAt?: number
}

export function mergeRefreshResponse(previous: Tokens, response: RefreshResponse): Tokens {
  return {
    accessToken: response.accessToken,
    expiresAt: response.expiresAt,
    refreshToken: response.refreshToken ?? previous.refreshToken,
    refreshTokenExpiresAt: response.refreshToken === undefined
      ? previous.refreshTokenExpiresAt
      : response.refreshTokenExpiresAt,
  }
}

// Experimental facts, NOT proposed public configuration fields. Conditional
// replay assumes this worker has not used a replacement or acquired a new grant.
export type RecoveryBehavior =
  | { readonly kind: 'strict' }
  | { readonly kind: 'reusable' }
  | { readonly kind: 'conditional'; readonly maximumAgeMillis: number }

function permitsRecovery(behavior: RecoveryBehavior, tokens: Tokens, startedAt: number, now: number) {
  if (tokens.refreshTokenExpiresAt !== undefined && now >= tokens.refreshTokenExpiresAt) return false
  switch (behavior.kind) {
    case 'strict': return false
    case 'reusable': return true
    case 'conditional':
      // No known expiry means insufficient local evidence for this experiment.
      return tokens.refreshTokenExpiresAt !== undefined
        && now >= startedAt
        && now - startedAt < behavior.maximumAgeMillis
  }
}

export type RecordState =
  | {
      readonly kind: 'ready'
      readonly version: number
      readonly tokens: Tokens
      readonly lastOperation: string | null
    }
  | {
      readonly kind: 'refreshing'
      readonly version: number
      readonly operation: string
      readonly tokens: Tokens
    }

export class StoreWriteFailed extends Data.TaggedError('StoreWriteFailed')<{}> {}
export class CommitConflict extends Data.TaggedError('CommitConflict')<{}> {}
export class ProviderOutcomeUnknown extends Data.TaggedError('ProviderOutcomeUnknown')<{}> {}
export class ProviderRejected extends Data.TaggedError('ProviderRejected')<{}> {}
export class RefreshUncertain extends Data.TaggedError('RefreshUncertain')<{
  readonly operation: string
  readonly stage: 'exchange' | 'persistence'
  readonly cause: ProviderOutcomeUnknown | StoreWriteFailed | CommitConflict
}> {}
export class RefreshPending extends Data.TaggedError('RefreshPending')<{
  readonly operation: string
}> {}

// One connection per fixture. These are capabilities under exploration, not
// proposed production method names. Atomicity belongs to the backing store.
export class Store extends Context.Service<Store, {
  readonly read: () => Effect.Effect<RecordState>
  readonly claim: (version: number, operation: string) => Effect.Effect<boolean>
  readonly commit: (
    version: number,
    operation: string,
    tokens: Tokens,
  ) => Effect.Effect<void, StoreWriteFailed | CommitConflict>
  // In-memory notifications stand in for polling/subscription + a version recheck.
  readonly awaitChange: (version: number) => Effect.Effect<void>
}>()('prototype/refresh/Store') {}

export class Provider extends Context.Service<Provider, {
  readonly recovery: RecoveryBehavior
  readonly refresh: (
    token: Redacted.Redacted<string>,
  ) => Effect.Effect<RefreshResponse, ProviderOutcomeUnknown | ProviderRejected>
}>()('prototype/refresh/Provider') {}

export function makeManager() {
  return {
    credentials: () => Effect.gen(function* () {
      const store = yield* Store
      const provider = yield* Provider

      for (;;) {
        const record = yield* store.read()
        if (record.kind === 'refreshing') {
          yield* store.awaitChange(record.version).pipe(
            Effect.timeoutOrElse({
              duration: '100 millis',
              orElse: () => Effect.fail(new RefreshPending({ operation: record.operation })),
            }),
          )
          continue
        }
        const now = yield* Clock.currentTimeMillis
        if (record.tokens.expiresAt > now) {
          // Refresh credentials remain internal, including in error values.
          return { accessToken: record.tokens.accessToken }
        }

        const operation = randomUUID()
        if (!(yield* store.claim(record.version, operation))) continue

        const startedAt = yield* Clock.currentTimeMillis
        // Retry only uncertain exchange failures where the provider permits it,
        // under the SAME claim and a bounded budget. This is not claim takeover.
        const response = yield* provider.refresh(record.tokens.refreshToken).pipe(
          Effect.retry({
            times: 2,
            while: (cause) => Effect.gen(function* () {
              if (cause._tag !== 'ProviderOutcomeUnknown') return false
              const current = yield* store.read()
              if (current.kind !== 'refreshing' || current.operation !== operation
                || current.version !== record.version + 1) return false
              return permitsRecovery(provider.recovery, record.tokens, startedAt, yield* Clock.currentTimeMillis)
            }),
          }),
          Effect.mapError((cause) => cause._tag === 'ProviderRejected'
            ? cause
            : new RefreshUncertain({ operation, stage: 'exchange', cause })),
        )
        const next = mergeRefreshResponse(record.tokens, response)

        // Retry only the identical, fenced, idempotent persistence operation.
        // Never retry the surrounding exchange + save workflow.
        yield* store.commit(record.version + 1, operation, next).pipe(
          Effect.retry({
            times: 2,
            while: (error) => error._tag === 'StoreWriteFailed',
          }),
          Effect.mapError((cause) => new RefreshUncertain({ operation, stage: 'persistence', cause })),
        )

        // Re-read after committing, rather than return unconfirmed local tokens.
      }
    }),
  }
}
