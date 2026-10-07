import { Clock, Effect, type Exit, type Layer, ManagedRuntime } from 'effect'
import { TestClock as EffectTestClock } from 'effect/testing'

export interface TestClock {
  readonly layer: Layer.Layer<EffectTestClock.TestClock>
  readonly initialize: Effect.Effect<void>
  readonly now: Effect.Effect<number>
  readonly advanceBy: (milliseconds: number) => Effect.Effect<void>
}

export function makeTestClock(initialTime = 0): TestClock {
  if (!Number.isFinite(initialTime)) {
    throw new TypeError('Initial fake time must be finite')
  }

  return {
    layer: EffectTestClock.layer(),
    initialize: EffectTestClock.setTime(initialTime),
    now: Clock.currentTimeMillis,
    advanceBy: (milliseconds) => {
      if (!Number.isFinite(milliseconds) || milliseconds < 0) {
        throw new TypeError('Fake time advances must be finite and non-negative')
      }
      return EffectTestClock.adjust(milliseconds)
    },
  }
}

export interface ControlledCheckpoint<Point> {
  readonly reached: Promise<void>
  readonly at: (point: Point) => Effect.Effect<void>
  readonly release: () => void
}

export function makeControlledCheckpoint<Point>(target: Point): ControlledCheckpoint<Point> {
  let markReached: () => void = () => undefined
  let resume: () => void = () => undefined
  const reached = new Promise<void>((resolve) => {
    markReached = resolve
  })
  const released = new Promise<void>((resolve) => {
    resume = resolve
  })

  return {
    reached,
    at: (point) =>
      Object.is(point, target)
        ? Effect.sync(markReached).pipe(Effect.andThen(Effect.promise(() => released)))
        : Effect.void,
    release: resume,
  }
}

export interface LifecycleExecution<A, E> {
  readonly exit: Promise<Exit.Exit<A, E>>
  readonly interrupt: () => void
}

export interface LifecycleDriver<R, LayerError> {
  readonly run: <A, E>(effect: Effect.Effect<A, E, R>) => Promise<A>
  readonly start: <A, E>(effect: Effect.Effect<A, E, R>) => LifecycleExecution<A, E | LayerError>
  readonly dispose: () => Promise<void>
}

export function makeLifecycleDriver<R, LayerError>(
  layer: Layer.Layer<R, LayerError, never>,
): LifecycleDriver<R, LayerError> {
  const runtime = ManagedRuntime.make(layer)

  return {
    run: (effect) => runtime.runPromise(effect),
    start: (effect) => {
      const controller = new AbortController()
      return {
        exit: runtime.runPromiseExit(effect, { signal: controller.signal }),
        interrupt: () => controller.abort(),
      }
    },
    dispose: () => runtime.dispose(),
  }
}
