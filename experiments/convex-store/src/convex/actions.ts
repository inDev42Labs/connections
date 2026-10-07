// Default Convex runtime deliberately: no "use node" or Node-only APIs.
import { v } from 'convex/values'
import { Deferred, Effect, Redacted, Result } from 'effect'
import { action } from './_generated/server'
import { Convex } from '../adapter'
import { keyFor, manager, store } from './connections'
import { requireLocalFixture } from './localOnly'

export const seed = action({
  args: { id: v.string() },
  returns: v.null(),
  handler: async (ctx, { id }): Promise<null> => {
    requireLocalFixture()
    await Convex.run(ctx, store.initialize(keyFor(id), {
      accessToken: Redacted.make('FAKE-access-0'),
      refreshToken: Redacted.make('FAKE-refresh-0'),
      expiresAt: 0,
    }))
    return null
  },
})

export const credentialsProbe = action({
  args: { id: v.string() },
  returns: v.object({ usable: v.boolean(), redacted: v.boolean() }),
  handler: async (ctx, { id }): Promise<{ usable: boolean; redacted: boolean }> => {
    requireLocalFixture()
    // Production apps authenticate/authorize here. This local fixture has no users.
    const use = await Convex.run(ctx, manager.connection(keyFor(id)).credentials())
    // Never return credentials to a browser; return only fixture assertions.
    return {
      usable: Redacted.value(use.credentials.accessToken) === 'FAKE-access-1',
      redacted: !JSON.stringify(use).includes('FAKE-access'),
    }
  },
})

export const runtimeProbe = action({
  args: {},
  returns: v.object({ timer: v.boolean(), interrupted: v.boolean(), finalized: v.boolean(), childFinalized: v.boolean() }),
  handler: async (ctx): Promise<{ timer: boolean; interrupted: boolean; finalized: boolean; childFinalized: boolean }> => {
    requireLocalFixture()
    let childFinalized = false
    const result = await Convex.run(ctx, Effect.gen(function* () {
      const started = yield* Deferred.make<void>()
      yield* Effect.forkScoped(Effect.gen(function* () {
        yield* Deferred.succeed(started, undefined)
        yield* Effect.never
      }).pipe(Effect.ensuring(Effect.sync(() => { childFinalized = true }))))
      yield* Deferred.await(started)
      let finalized = false
      yield* Effect.sleep('1 millis')
      const result = yield* Effect.never.pipe(
        Effect.ensuring(Effect.sync(() => { finalized = true })),
        Effect.timeout('5 millis'),
        Effect.result,
      )
      return { timer: true, interrupted: Result.isFailure(result), finalized }
    }))
    return { ...result, childFinalized }
  },
})
