import { Clock, Effect } from 'effect'
import type { ConnectionStore } from './contracts/store.js'
import { digestStoreInput } from './contracts/store.js'
import { InspectionFailure, RemovalFailure } from './failures.js'
import type { ConnectionIdentity, ConnectionInspection } from './model.js'
import { randomRequestId } from '../internal/ids.js'

export function makeLocalLifecycle<Error, Requirements, InspectionError, InspectionRequirements>(
  store: ConnectionStore<Error, Requirements, InspectionError, InspectionRequirements>,
) {
  const readForRemoval = (key: ConnectionIdentity) =>
    store
      .readConnection(key)
      .pipe(Effect.mapError(() => new RemovalFailure({ reason: 'StorageFailure' })))

  return {
    inspect: (identity: ConnectionIdentity) =>
      store.inspectConnection(identity).pipe(
        Effect.mapError(() => new InspectionFailure({ reason: 'StorageFailure' })),
        Effect.map((stored): ConnectionInspection => ({
          savedAuthorization: stored?.savedAuthorization ?? false,
          credentialWork: stored?.credentialWork ?? 'idle',
        })),
      ),
    remove: (identity: ConnectionIdentity): Effect.Effect<void, RemovalFailure, Requirements> =>
      Effect.gen(function* () {
        const current = yield* readForRemoval(identity)
        if (current === null || current.authorization._tag === 'NotAuthorized') return

        const input = {
          _tag: 'RemoveConnection' as const,
          key: identity,
          expectedGeneration: current.generation,
          expectedRevision: current.revision,
          removedAt: yield* Clock.currentTimeMillis,
        }
        const command = yield* Effect.tryPromise({
          try: async () => ({
            ...input,
            request: { requestId: randomRequestId(), inputDigest: await digestStoreInput(input) },
          }),
          catch: () => new RemovalFailure({ reason: 'StorageFailure' }),
        })
        const result = yield* store.executeCredentialOperation(command).pipe(
          Effect.retry({ times: 2 }),
          Effect.mapError(() => new RemovalFailure({ reason: 'StorageFailure' })),
        )
        if (result._tag === 'ConnectionRemoved') {
          const confirmed = yield* readForRemoval(identity)
          if (
            confirmed !== null &&
            confirmed.authorization._tag === 'NotAuthorized' &&
            confirmed.generation === result.generation &&
            confirmed.revision === result.revision &&
            confirmed.credentialOperation === null
          )
            return
        }
        return yield* Effect.fail(new RemovalFailure({ reason: 'Conflict' }))
      }),
  }
}
