import { Clock, Effect } from 'effect'
import type { ConnectionSnapshot } from '../core/contracts/store.js'

export const credentialOperationOwnershipLeaseMilliseconds = 30_000
export const credentialFollowerWaitMilliseconds = 5_000
export const credentialOperationRecoveryMilliseconds = 2 * 60_000
export const credentialOperationTransferLimit = 3

const credentialFollowerPollMilliseconds = 25

export function waitForConnectionRevision<Error, Requirements>(options: {
  readonly observedRevision: number
  readonly waitUntil: number
  readonly read: () => Effect.Effect<ConnectionSnapshot | null, Error, Requirements>
}): Effect.Effect<ConnectionSnapshot | null, Error, Requirements> {
  return Effect.gen(function* () {
    for (;;) {
      const now = yield* Clock.currentTimeMillis
      if (now >= options.waitUntil) return null
      yield* Effect.sleep(Math.min(credentialFollowerPollMilliseconds, options.waitUntil - now))
      const snapshot = yield* options.read()
      if (snapshot === null || snapshot.revision !== options.observedRevision) return snapshot
    }
  })
}
