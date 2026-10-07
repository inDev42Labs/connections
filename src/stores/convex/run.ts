import { Cause, Effect, Exit, Layer, Scope } from 'effect'
import {
  layer,
  type ConvexInvocation,
  type ConvexInvocationContext,
  type ConvexQueryInvocation,
  type ConvexQueryInvocationContext,
} from './layer.js'

export interface RunOptions {
  readonly signal?: AbortSignal
}

async function structuredPromise<Value, Error>(
  effect: Effect.Effect<Value, Error>,
  options?: RunOptions,
): Promise<Value> {
  const exit = await Effect.runPromiseExit(effect, options)
  if (Exit.isSuccess(exit)) return exit.value
  throw Cause.squash(exit.cause)
}

function runWithLayer<Value, Error, Requirements>(
  operation: Effect.Effect<Value, Error, Requirements | Scope.Scope>,
  requirements: Layer.Layer<Requirements>,
  options?: RunOptions,
): Promise<Value> {
  return structuredPromise(Effect.scoped(operation.pipe(Effect.provide(requirements))), options)
}

export function run<Value, Error>(
  context: ConvexInvocationContext,
  operation: Effect.Effect<Value, Error, ConvexInvocation | ConvexQueryInvocation | Scope.Scope>,
  options?: RunOptions,
): Promise<Value>
export function run<Value, Error>(
  context: ConvexQueryInvocationContext,
  operation: Effect.Effect<Value, Error, ConvexQueryInvocation | Scope.Scope>,
  options?: RunOptions,
): Promise<Value>
export function run<Value, Error>(
  context: ConvexQueryInvocationContext,
  operation: Effect.Effect<Value, Error, ConvexInvocation | ConvexQueryInvocation | Scope.Scope>,
  options?: RunOptions,
): Promise<Value> {
  if ('runMutation' in context) {
    return runWithLayer(
      operation as Effect.Effect<
        Value,
        Error,
        ConvexInvocation | ConvexQueryInvocation | Scope.Scope
      >,
      layer(context as ConvexInvocationContext),
      options,
    )
  }
  return runWithLayer(
    operation as Effect.Effect<Value, Error, ConvexQueryInvocation | Scope.Scope>,
    layer(context),
    options,
  )
}
