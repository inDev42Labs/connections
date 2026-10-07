import { Effect } from 'effect'
import type {
  ConnectionKey,
  ConnectionStore,
  CredentialOperationCommandInput,
  MutationRequest,
} from './contracts/store.js'
import { digestStoreInput } from './contracts/store.js'
import { CredentialRejectionFailure } from './failures.js'
import { randomRequestId } from '../internal/ids.js'

function request<Command extends CredentialOperationCommandInput>(
  input: Command,
): Effect.Effect<Command & { readonly request: MutationRequest }, CredentialRejectionFailure> {
  return Effect.tryPromise({
    try: async () => ({
      ...input,
      request: { requestId: randomRequestId(), inputDigest: await digestStoreInput(input) },
    }),
    catch: () => new CredentialRejectionFailure({ reason: 'StorageFailure' }),
  })
}

export function reportCredentialRejected<
  StoreError,
  StoreRequirements,
  InspectionError,
  InspectionRequirements,
>(
  store: ConnectionStore<StoreError, StoreRequirements, InspectionError, InspectionRequirements>,
  key: ConnectionKey,
  generation: number,
  revision: number,
): Effect.Effect<void, CredentialRejectionFailure, StoreRequirements> {
  return Effect.gen(function* () {
    const command = yield* request({
      _tag: 'InvalidateCredential' as const,
      key,
      expectedGeneration: generation,
      expectedRevision: revision,
    })
    const result = yield* store
      .executeCredentialOperation(command)
      .pipe(Effect.mapError(() => new CredentialRejectionFailure({ reason: 'StorageFailure' })))
    if (result._tag === 'CredentialInvalidated' || result._tag === 'StoreConflict') return
    return yield* Effect.fail(new CredentialRejectionFailure({ reason: 'Conflict' }))
  })
}
