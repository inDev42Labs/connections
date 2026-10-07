import {
  bindPromiseManager,
  type PromiseEffectRunner,
  type PromiseManagerRunners,
  type UnboundPromiseManager,
} from '../../core/manager.js'
import { run } from './run.js'
import type {
  ConvexInvocation,
  ConvexInvocationContext,
  ConvexQueryInvocation,
  ConvexQueryInvocationContext,
} from './store.js'

type InspectablePromiseManager = { readonly inspect: (id: string) => Promise<unknown> }

export type QueryPromiseManager<Manager extends InspectablePromiseManager> = Readonly<
  Pick<Manager, 'inspect'>
>

export function bind<Manager extends InspectablePromiseManager>(
  context: ConvexInvocationContext,
  manager: UnboundPromiseManager<Manager, ConvexInvocation, ConvexQueryInvocation>,
): Manager
export function bind<Manager extends InspectablePromiseManager>(
  context: ConvexQueryInvocationContext,
  manager: UnboundPromiseManager<Manager, ConvexInvocation, ConvexQueryInvocation>,
): QueryPromiseManager<Manager>
export function bind<Manager extends InspectablePromiseManager>(
  context: ConvexInvocationContext | ConvexQueryInvocationContext,
  manager: UnboundPromiseManager<Manager, ConvexInvocation, ConvexQueryInvocation>,
): Manager | QueryPromiseManager<Manager> {
  const inspectionRunner: PromiseEffectRunner<ConvexQueryInvocation> = (operation) =>
    run(context, operation)

  if ('runMutation' in context) {
    const actionRunner: PromiseEffectRunner<ConvexInvocation> = (operation) =>
      run(context, operation)
    const runners: PromiseManagerRunners<ConvexInvocation, ConvexQueryInvocation> = {
      action: actionRunner,
      inspection: inspectionRunner,
      removal: actionRunner,
    }
    return manager[bindPromiseManager](runners)
  }

  const unavailable: PromiseEffectRunner<ConvexInvocation> = () =>
    Promise.reject(new Error('Query bindings only permit read-only inspection'))
  const queryRunners: PromiseManagerRunners<ConvexInvocation, ConvexQueryInvocation> = {
    action: unavailable,
    inspection: inspectionRunner,
    removal: unavailable,
  }
  const bound = manager[bindPromiseManager](queryRunners)
  const queryManager: QueryPromiseManager<Manager> = { inspect: bound.inspect }
  return Object.freeze(queryManager)
}
