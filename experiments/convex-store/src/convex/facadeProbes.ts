// THROWAWAY local-only integration probes. Never return credentials or ciphertext.
import { v } from 'convex/values'
import { getFunctionAddress } from 'convex/server'
import type { FunctionArgs } from 'convex/server'
import { Effect, Redacted } from 'effect'
import { action, env, query } from './_generated/server'
import { components } from './_generated/api'
import { AesGcm, ClientDisposed, Convex, fakeHttpRefresh, makeManager, ProviderError } from '../adapter'
import type { PromiseConnection } from '../adapter'
import { keyFor } from './connections'
import { requireLocalFixture } from './localOnly'

const refs = components.credentialStore.records

export const inspect = query({
  args: { id: v.string() },
  returns: v.object({ savedAuthorization: v.boolean(), credentialWorkPending: v.boolean() }),
  handler: async (ctx, { id }) => {
    requireLocalFixture()
    const store = Convex.store({ component: components.credentialStore,
      encryptor: AesGcm.make(() => { throw new Error('Inspection must not resolve encryption keys') }),
    })
    const manager = makeManager({ store, refresh: () => Effect.fail(new ProviderError()) })
    return Convex.inspect({ runQuery: ctx.runQuery }, manager.connection(keyFor(id)))
  },
})

export const acknowledgement = action({
  args: { id: v.string() },
  returns: v.object({ usable: v.boolean(), encryptions: v.number(), completions: v.number(),
    identicalWrites: v.boolean(), disposed: v.boolean(), finalized: v.boolean() }),
  handler: async (ctx, { id }) => {
    requireLocalFixture()
    let encryptions = 0
    const cipher = AesGcm.make(() => env.CONNECTIONS_TEST_KEY)
    const store = Convex.store({ component: components.credentialStore, encryptor: {
      ...cipher,
      encrypt: (key, tokens) => Effect.suspend(() => { encryptions++; return cipher.encrypt(key, tokens) }),
    } })
    const key = keyFor(id)
    await Convex.run(ctx, store.initialize(key, {
      accessToken: Redacted.make('FAKE-access-0'), refreshToken: Redacted.make('FAKE-refresh-0'), expiresAt: 0,
    }))
    encryptions = 0
    let completions = 0
    let firstPayload: unknown
    let firstBytes: string | undefined
    let identicalWrites = false
    const lossy: Parameters<typeof Convex.layer>[0] = {
      runQuery: ctx.runQuery,
      runMutation: async (ref, ...args) => {
        const isCompletion = JSON.stringify(getFunctionAddress(ref)) === JSON.stringify(getFunctionAddress(refs.complete))
        if (isCompletion) {
          const payload = args[0] as FunctionArgs<typeof refs.complete>
          const bytes = JSON.stringify({ ...payload, envelope: {
            ...payload.envelope,
            iv: Array.from(new Uint8Array(payload.envelope.iv)),
            ciphertext: Array.from(new Uint8Array(payload.envelope.ciphertext)),
          } })
          completions++
          if (completions === 1) { firstPayload = payload; firstBytes = bytes }
          else identicalWrites = firstPayload === payload && firstBytes === bytes
        }
        const result = await ctx.runMutation(ref, ...args)
        if (isCompletion && completions === 1) throw new Error('Injected AFTER APPLY acknowledgement loss')
        return result
      },
    }
    const base = makeManager({ store, refresh: fakeHttpRefresh(() => env.CONVEX_SITE_URL) })
    let finalized = false
    const manager = { connection: (connectionKey: string) => ({
      ...base.connection(connectionKey),
      credentials: () => Effect.gen(function* () {
        // This finalizer belongs to the facade invocation, not one credential call.
        yield* Effect.addFinalizer(() => Effect.sleep('5 millis').pipe(Effect.andThen(Effect.sync(() => { finalized = true }))))
        return yield* base.connection(connectionKey).credentials()
      }),
    }) }
    let escaped: PromiseConnection<{ accessToken: Redacted.Redacted<string> }> | undefined
    const usable = await Convex.withClient(lossy, manager, async (client) => {
      escaped = client.connection(key)
      const tokens = await escaped.credentials()
      if (finalized) throw new Error('Invocation finalized before callback exit')
      return Redacted.value(tokens.accessToken) === 'FAKE-access-1'
    })
    let disposed = false
    try { await escaped!.inspect() } catch (error) { disposed = error instanceof ClientDisposed }
    return { usable, encryptions, completions, identicalWrites, disposed, finalized }
  },
})
