// Fake backend contracts for the refresh experiment. Nothing is durable across
// process exit. Atomic synchronous mutations SIMULATE backing-store transactions.
import { Clock, Deferred, Effect, Redacted } from 'effect'
import {
  CommitConflict,
  ProviderOutcomeUnknown,
  ProviderRejected,
  StoreWriteFailed,
} from './model'
import type { Provider, RecordState, RecoveryBehavior, RefreshResponse, Store, Tokens } from './model'

export const DAY = 24 * 60 * 60 * 1_000
interface FakeGrant {
  readonly expiresAt: number
  readonly parent?: string
  firstUsedAt?: number
  retired: boolean
}

export interface FixtureOptions {
  readonly profile?: 'strict' | 'reusable' | 'conditional'
  readonly lostResponses?: number
  readonly advanceAfterLostResponseMillis?: number
  readonly initialRefreshLifetimeMillis?: number
  readonly omitInitialExpiryMetadata?: boolean
  readonly synchronizeReaders?: boolean
  readonly pauseAfterRotation?: boolean
  readonly loseProviderResponse?: boolean
  readonly rejectRefresh?: boolean
  readonly failWrites?: 'once-before' | 'always-before' | 'once-after'
}

export const makeFixture = (options: FixtureOptions = {}) => Effect.gen(function* () {
  const liveClock = yield* Clock.Clock
  let now = 1_000
  const profile = options.profile ?? 'strict'
  const initialExpiry = options.initialRefreshLifetimeMillis !== undefined
    ? now + options.initialRefreshLifetimeMillis
    : profile === 'reusable' ? Infinity : now + 90 * DAY
  const recovery: RecoveryBehavior = profile === 'conditional'
    ? { kind: 'conditional', maximumAgeMillis: 30 * DAY }
    : { kind: profile }
  const grants = new Map<string, FakeGrant>([
    ['FAKE-refresh-0', { expiresAt: initialExpiry, retired: false }],
  ])
  const clock: Clock.Clock = {
    // Delegate methods explicitly: the live clock has prototype methods that
    // object spread would omit, despite TypeScript accepting the spread.
    sleep: (duration) => liveClock.sleep(duration),
    monotonicTimeNanosUnsafe: () => liveClock.monotonicTimeNanosUnsafe(),
    monotonicTimeNanos: liveClock.monotonicTimeNanos,
    currentTimeMillisUnsafe: () => now,
    currentTimeMillis: Effect.sync(() => now),
    currentTimeNanosUnsafe: () => BigInt(now) * 1_000_000n,
    currentTimeNanos: Effect.sync(() => BigInt(now) * 1_000_000n),
  }
  const tokens = (generation: number, expiresAt: number): Tokens => ({
    accessToken: Redacted.make(`FAKE-access-${generation}`),
    refreshToken: Redacted.make(`FAKE-refresh-${generation}`),
    expiresAt,
    refreshTokenExpiresAt: generation === 0
      ? options.omitInitialExpiryMetadata || !Number.isFinite(initialExpiry) ? undefined : initialExpiry
      : now + 90 * DAY,
  })
  let state: RecordState = {
    kind: 'ready', version: 0, tokens: tokens(0, 0), lastOperation: null,
  }
  let generation = 0
  let changes = yield* Deferred.make<void>()
  const readersReady = yield* Deferred.make<void>()
  const exchanged = yield* Deferred.make<void>()
  const allowResponse = yield* Deferred.make<void>()
  const clientBWaiting = yield* Deferred.make<void>()
  const readers = new Set<string>()
  const submitted: Array<Redacted.Redacted<string>> = []
  const writes: Array<{ readonly operation: string; readonly tokens: Tokens }> = []
  const stats = {
    providerCalls: 0,
    providerRejections: 0,
    lostResponses: 0,
    claims: 0,
    lostClaims: 0,
    commits: 0,
    commitCalls: 0,
    rejectedCommits: 0,
    activeWaiters: 0,
  }
  let beforeFailures = options.failWrites === 'always-before'
    ? Infinity : options.failWrites === 'once-before' ? 1 : 0
  let loseCommitAcknowledgement = options.failWrites === 'once-after'
  let remainingLostResponses = options.loseProviderResponse ? Infinity : options.lostResponses ?? 0

  const publish = () => {
    const previous = changes
    changes = Deferred.makeUnsafe<void>()
    return Deferred.succeed(previous, undefined).pipe(Effect.asVoid)
  }

  const client = (name: string): Store['Service'] => ({
    read: () => Effect.gen(function* () {
      const snapshot = state
      // Force both independent clients to read version 0 before either can claim.
      if (options.synchronizeReaders && snapshot.version === 0) {
        readers.add(name)
        if (readers.has('A') && readers.has('B')) {
          yield* Deferred.succeed(readersReady, undefined)
        }
        yield* Deferred.await(readersReady)
      }
      return snapshot
    }),
    claim: (version, operation) => Effect.gen(function* () {
      if (state.kind !== 'ready' || state.version !== version) {
        stats.lostClaims++
        return false
      }
      // No suspension between compare and mutation: simulated atomic claim.
      state = { kind: 'refreshing', version: version + 1, tokens: state.tokens, operation }
      stats.claims++
      yield* publish()
      return true
    }),
    commit: (version, operation, next) => Effect.gen(function* () {
      stats.commitCalls++
      writes.push({ operation, tokens: next })
      // An acknowledged retry after an applied write does not overwrite anything.
      if (state.kind === 'ready' && state.lastOperation === operation && state.version === version + 1) {
        return
      }
      if (state.kind !== 'refreshing' || state.version !== version || state.operation !== operation) {
        stats.rejectedCommits++
        return yield* Effect.fail(new CommitConflict())
      }
      if (beforeFailures > 0) {
        beforeFailures--
        return yield* Effect.fail(new StoreWriteFailed())
      }
      state = { kind: 'ready', version: version + 1, tokens: next, lastOperation: operation }
      stats.commits++
      yield* publish()
      if (loseCommitAcknowledgement) {
        loseCommitAcknowledgement = false
        return yield* Effect.fail(new StoreWriteFailed())
      }
    }),
    awaitChange: (version) => Effect.suspend(() => {
      // Check version and capture notification together to avoid a missed wakeup.
      if (state.version !== version) return Effect.void
      const notification = changes
      return Effect.acquireUseRelease(
        Effect.sync(() => { stats.activeWaiters++ }),
        () => Effect.gen(function* () {
          if (name === 'B') yield* Deferred.succeed(clientBWaiting, undefined)
          yield* Deferred.await(notification)
        }),
        () => Effect.sync(() => { stats.activeWaiters-- }),
      )
    }),
  })

  const provider: Provider['Service'] = {
    recovery,
    refresh: (token) => Effect.gen(function* () {
      stats.providerCalls++
      submitted.push(token)
      const key = Redacted.value(token)
      const grant = grants.get(key)
      if (options.rejectRefresh || grant === undefined || grant.retired || now >= grant.expiresAt
        || (profile === 'conditional' && grant.firstUsedAt !== undefined && now - grant.firstUsedAt >= 30 * DAY)) {
        stats.providerRejections++
        return yield* Effect.fail(new ProviderRejected())
      }
      if (profile === 'strict') grant.retired = true
      if (profile === 'conditional') {
        grant.firstUsedAt ??= now
        if (grant.parent !== undefined) {
          const parent = grants.get(grant.parent)
          if (parent !== undefined) parent.retired = true
        }
      }
      // Each successful request produces a DIFFERENT access token. Conditional
      // replay deliberately does not assume an identical replacement response.
      generation++
      const next = tokens(generation, now + 60_000)
      const response: RefreshResponse = profile === 'reusable'
        ? { accessToken: next.accessToken, expiresAt: next.expiresAt }
        : next
      if (profile !== 'reusable') {
        grants.set(Redacted.value(next.refreshToken), {
          expiresAt: now + 90 * DAY,
          parent: profile === 'conditional' ? key : undefined,
          retired: false,
        })
      }
      yield* Deferred.succeed(exchanged, undefined)
      if (options.pauseAfterRotation) yield* Deferred.await(allowResponse)
      if (remainingLostResponses > 0) {
        remainingLostResponses--
        stats.lostResponses++
        now += options.advanceAfterLostResponseMillis ?? 0
        return yield* Effect.fail(new ProviderOutcomeUnknown())
      }
      return response
    }),
  }

  return {
    clock, client, provider, stats, submitted, writes,
    exchanged: Deferred.await(exchanged),
    clientBWaiting: Deferred.await(clientBWaiting),
    releaseResponse: Deferred.succeed(allowResponse, undefined),
    snapshot: () => state,
    remoteGeneration: () => generation,
    advanceTime: (millis = 60_001) => { now += millis },
    // Test-only external activity: a new grant/uninstall can retire every token.
    retireAllRefreshTokens: () => { for (const grant of grants.values()) grant.retired = true },
    // Exposes the fake backend, not a provider capability available to the manager.
    tokenIsRetired: (token: Redacted.Redacted<string>) => grants.get(Redacted.value(token))?.retired,
  }
})
