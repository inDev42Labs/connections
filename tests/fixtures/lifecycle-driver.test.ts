import { Cause, Effect, Exit, Fiber, Layer } from 'effect'
import { describe, expect, test } from 'vitest'
import { makeControlledCheckpoint, makeLifecycleDriver, makeTestClock } from './lifecycle-driver.js'
import { assertSecretCanariesAbsent, makeSecretCanary } from './secret-assertions.js'

describe('lifecycle test fixtures', () => {
  test('advances fake time and wakes sleeping effects deterministically', async () => {
    const clock = makeTestClock(1_000)
    let woke = false
    const program = Effect.gen(function* () {
      yield* clock.initialize
      expect(yield* clock.now).toBe(1_000)
      const sleeper = yield* Effect.sleep(250).pipe(
        Effect.andThen(Effect.sync(() => (woke = true))),
        Effect.forkChild,
      )

      yield* clock.advanceBy(250)
      yield* Fiber.join(sleeper)
      return yield* clock.now
    })

    await expect(Effect.runPromise(Effect.provide(program, clock.layer))).resolves.toBe(1_250)
    expect(woke).toBe(true)
    expect(() => clock.advanceBy(-1)).toThrow('non-negative')
  })

  test('pauses and interrupts lifecycle execution at a controlled checkpoint', async () => {
    const checkpoint = makeControlledCheckpoint('dispatch-reserved')
    const driver = makeLifecycleDriver(Layer.empty)
    const execution = driver.start(checkpoint.at('dispatch-reserved').pipe(Effect.as('completed')))

    await checkpoint.reached
    execution.interrupt()

    const exit = await execution.exit
    expect(Exit.isFailure(exit) && Cause.hasInterrupts(exit.cause)).toBe(true)
    await driver.dispose()
  })

  test('releases lifecycle execution from a controlled checkpoint', async () => {
    const checkpoint = makeControlledCheckpoint('response-received')
    const driver = makeLifecycleDriver(Layer.empty)
    const execution = driver.start(checkpoint.at('response-received').pipe(Effect.as('completed')))

    await checkpoint.reached
    checkpoint.release()

    await expect(execution.exit).resolves.toSatisfy(Exit.isSuccess)
    await driver.dispose()
  })

  test('detects secret canaries without reproducing their values in diagnostics', () => {
    const accessToken = makeSecretCanary('access token')
    const refreshToken = makeSecretCanary('refresh token')

    expect(() =>
      assertSecretCanariesAbsent([accessToken, refreshToken], {
        publicResult: 'safe metadata',
      }),
    ).not.toThrow()

    let failure: unknown
    try {
      assertSecretCanariesAbsent([accessToken, refreshToken], {
        nested: [refreshToken.value],
      })
    } catch (error) {
      failure = error
    }

    expect(failure).toBeInstanceOf(Error)
    expect(String(failure)).toContain('refresh token')
    expect(String(failure)).not.toContain(refreshToken.value)

    const concealedLeak = {
      token: accessToken.value,
      [Symbol.for('nodejs.util.inspect.custom')]: () => 'safe',
    }
    expect(() => assertSecretCanariesAbsent([accessToken], concealedLeak)).toThrow('access token')
    expect(() =>
      assertSecretCanariesAbsent([accessToken], {
        [accessToken.value]: 'secret used as a property key',
        [Symbol.for('nodejs.util.inspect.custom')]: () => 'safe',
      }),
    ).toThrow('access token')
  })
})
