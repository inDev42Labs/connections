import type { Effect } from 'effect'
import type {
  ConnectionSnapshot,
  ConnectionStore,
  StoreCommandResult,
} from '../core/contracts/store.js'
import { digestStoreInput } from '../core/contracts/store.js'

export type StoreConformanceRunner<Error, Requirements> = <Value>(
  effect: Effect.Effect<Value, Error, Requirements>,
) => Promise<Value>

export interface StoreConformanceReport {
  readonly initialResult: StoreCommandResult
  readonly replayedResult: StoreCommandResult
  readonly requestReuse: StoreCommandResult
  readonly changedCondition: StoreCommandResult
  readonly snapshot: ConnectionSnapshot | null
}

export async function verifyStoreConformance<
  Error,
  Requirements,
  InspectionError,
  InspectionRequirements,
>(
  store: ConnectionStore<Error, Requirements, InspectionError, InspectionRequirements>,
  run: StoreConformanceRunner<Error, Requirements>,
  uniqueName: string,
): Promise<StoreConformanceReport> {
  const key = {
    namespace: `conformance:${uniqueName}`,
    providerId: 'salesforce',
    connectionId: 'connection',
  }
  const inputDigest = await digestStoreInput({ _tag: 'InitializeConnection', key })
  const command = {
    _tag: 'InitializeConnection',
    request: { requestId: 'initialize-1', inputDigest },
    key,
  } as const

  const initialResult = await run(store.execute(command))
  const replayedResult = await run(store.execute(command))
  const requestReuse = await run(
    store.execute({
      ...command,
      request: { ...command.request, inputDigest: `${inputDigest}-different` },
    }),
  )
  const changedCondition = await run(
    store.execute({
      ...command,
      request: { requestId: 'initialize-2', inputDigest },
    }),
  )
  const snapshot = await run(store.readConnection(key))

  return {
    initialResult,
    replayedResult,
    requestReuse,
    changedCondition,
    snapshot,
  }
}
