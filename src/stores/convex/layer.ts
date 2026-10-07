import { Layer } from 'effect'
import {
  ConvexInvocation,
  ConvexQueryInvocation,
  type ConvexInvocationContext,
  type ConvexQueryInvocationContext,
} from './store.js'

export type {
  ConvexInvocation,
  ConvexInvocationContext,
  ConvexQueryInvocation,
  ConvexQueryInvocationContext,
} from './store.js'

function hasMutationCapability(
  context: ConvexQueryInvocationContext,
): context is ConvexInvocationContext {
  return 'runMutation' in context
}

export function layer(
  context: ConvexInvocationContext,
): Layer.Layer<ConvexInvocation | ConvexQueryInvocation>
export function layer(context: ConvexQueryInvocationContext): Layer.Layer<ConvexQueryInvocation>
export function layer(context: ConvexQueryInvocationContext) {
  const query = Layer.succeed(ConvexQueryInvocation, context)
  return hasMutationCapability(context)
    ? Layer.merge(query, Layer.succeed(ConvexInvocation, context))
    : query
}
