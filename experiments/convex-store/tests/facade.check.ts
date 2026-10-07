import { describe, expect, expectTypeOf, test } from 'vitest'
import { convexTest } from 'convex-test'
import { getFunctionAddress } from 'convex/server'
import type { FunctionArgs } from 'convex/server'
import { Effect, Redacted } from 'effect'
import appSchema from '../src/convex/schema'
import componentSchema from '../src/component/schema'
import { components } from '../src/convex/_generated/api'
import { AesGcm, CipherError, ClientDisposed, Convex, makeManager, ProviderError, StoreError } from '../src/adapter'
import type { PromiseConnection, Tokens } from '../src/adapter'

const appModules = import.meta.glob(['../src/convex/**/*.{ts,js}', '!../src/convex/**/*.d.ts'])
const componentModules = import.meta.glob('../src/component/**/*.ts')
const refs = components.credentialStore.records
const fakeKey = btoa(String.fromCharCode(...new Uint8Array(32).fill(42)))
const tokens = (access = 'FAKE-access-0', expiresAt = 0): Tokens => ({
  accessToken: Redacted.make(access), refreshToken: Redacted.make('FAKE-refresh-0'), expiresAt,
})
function setup() {
  const t = convexTest(appSchema, appModules)
  t.registerComponent('credentialStore', componentSchema, componentModules)
  const store = Convex.store({ component: components.credentialStore, encryptor: AesGcm.make(() => fakeKey) })
  return { t, store }
}
const noRefresh = () => Effect.fail(new ProviderError())

describe('invocation-scoped Promise facade (mock backend only)', () => {
  test('same manager serves Effect, Promise, and query-only non-secret inspection without keys', async () => {
    const { t, store } = setup()
    await t.action(async (ctx) => Convex.run(ctx, store.initialize('read', tokens('FAKE-current', Date.now() + 60_000))))
    let keyReads = 0
    const noKeyStore = Convex.store({ component: components.credentialStore,
      encryptor: AesGcm.make(() => { keyReads++; throw new Error('Query must not resolve a key') }),
    })
    const manager = makeManager({ store: noKeyStore, refresh: noRefresh })
    // This is an actual convex-test query dispatch with only query capabilities.
    expect(await t.query(async (ctx) => Convex.inspect({ runQuery: async (ref, ...args) => {
      // The parent query cannot fetch encrypted records through inspection.
      expect(getFunctionAddress(ref)).toEqual(getFunctionAddress(refs.inspect))
      return ctx.runQuery(ref, ...args)
    } }, manager.connection('read'))))
      .toEqual({ savedAuthorization: true, credentialWorkPending: false })
    expect(await t.query(async (ctx) => Convex.inspect(ctx, manager.connection('missing'))))
      .toEqual({ savedAuthorization: false, credentialWorkPending: false })
    await t.mutation(refs.claim, { key: 'read', expectedVersion: 0, owner: 'pending', leaseMs: 5_000 })
    expect(await t.query(async (ctx) => Convex.inspect(ctx, manager.connection('read'))))
      .toEqual({ savedAuthorization: true, credentialWorkPending: true })
    expect(keyReads).toBe(0)
    const queryFailure = { runQuery: (() => Promise.reject(new Error('storage unavailable'))) as Parameters<typeof Convex.inspect>[0]['runQuery'] }
    await expect(Convex.inspect(queryFailure, manager.connection('read'))).rejects.toBeInstanceOf(StoreError)

    const usable = makeManager({ store, refresh: noRefresh })
    await t.action(async (ctx) => {
      await Convex.run(ctx, store.initialize('usable', tokens('FAKE-current', Date.now() + 60_000)))
      const native = await Convex.run(ctx, usable.connection('usable').credentials())
      await Convex.withClient(ctx, usable, async (client) => {
        expect(Redacted.value((await client.connection('usable').credentials()).accessToken)).toBe(Redacted.value(native.accessToken))
        expect(await client.connection('usable').inspect()).toEqual({ savedAuthorization: true, credentialWorkPending: false })
      })
      // A provider-specific result remains inferred through the generic facade.
      const specialized = { connection: (key: string) => ({
        ...usable.connection(key),
        credentials: () => usable.connection(key).credentials().pipe(Effect.map((value) => ({ ...value, instanceUrl: 'https://example.invalid' }))),
      }) }
      const result = Convex.withClient(ctx, specialized, async (client) => {
        const value = await client.connection('usable').credentials()
        expectTypeOf(value.accessToken).toEqualTypeOf<Redacted.Redacted<string>>()
        expectTypeOf(value.instanceUrl).toEqualTypeOf<string>()
        // @ts-expect-error Provider output must not become any.
        value.apiDomain
        return value.instanceUrl
      })
      expectTypeOf(result).toEqualTypeOf<Promise<string>>()
      await result
      if (false) {
        // @ts-expect-error Query-only capabilities cannot run credential workflows.
        Convex.withClient({ runQuery: ctx.runQuery }, usable, async () => undefined)
      }
    })
  })

  test('preserves structured storage, cipher, provider, and callback errors; escaped handles fail closed', async () => {
    const { t, store } = setup()
    await t.action(async (ctx) => {
      const providerError = new ProviderError()
      const manager = makeManager({ store, refresh: () => Effect.fail(providerError) })
      await expect(Convex.withClient(ctx, manager, (client) => client.connection('missing').credentials())).rejects.toBeInstanceOf(StoreError)
      await Convex.run(ctx, store.initialize('provider-error', tokens()))
      await expect(Convex.withClient(ctx, manager, (client) => client.connection('provider-error').credentials())).rejects.toBe(providerError)
      await Convex.run(ctx, store.initialize('cipher-error', tokens()))
      const bad = makeManager({ store: Convex.store({ component: components.credentialStore, encryptor: AesGcm.make(() => undefined) }), refresh: noRefresh })
      await expect(Convex.withClient(ctx, bad, (client) => client.connection('cipher-error').credentials())).rejects.toBeInstanceOf(CipherError)
      const escaped = await Convex.withClient(ctx, manager, async (client) => client.connection('missing'))
      await expect(escaped.credentials()).rejects.toBeInstanceOf(ClientDisposed)
      await expect(escaped.inspect()).rejects.toBeInstanceOf(ClientDisposed)
      const applicationError = { kind: 'application-permission-denied' }
      let failedHandle: PromiseConnection<{ accessToken: Redacted.Redacted<string> }> | undefined
      await expect(Convex.withClient(ctx, manager, async (client) => {
        failedHandle = client.connection('missing')
        throw applicationError
      })).rejects.toBe(applicationError)
      await expect(failedHandle!.inspect()).rejects.toBeInstanceOf(ClientDisposed)
    })
  })

  test('abort closes library scope and handles even while the application callback remains pending', async () => {
    const { t, store } = setup()
    let started!: () => void
    const ready = new Promise<void>((resolve) => { started = resolve })
    let release!: () => void
    const applicationGate = new Promise<void>((resolve) => { release = resolve })
    let callbackDone!: () => void
    const callbackFinished = new Promise<void>((resolve) => { callbackDone = resolve })
    let finalized = false
    let applicationContinued = false
    const manager = makeManager({ store, refresh: () => Effect.gen(function* () {
      yield* Effect.addFinalizer(() => Effect.sync(() => { finalized = true }))
      started()
      return yield* Effect.never
    }).pipe(Effect.scoped) })
    await t.action(async (ctx) => {
      await Convex.run(ctx, store.initialize('abort', tokens()))
      const controller = new AbortController()
      let escaped!: PromiseConnection<{ accessToken: Redacted.Redacted<string> }>
      const invocation = Convex.withClient(ctx, manager, async (client) => {
        escaped = client.connection('abort')
        void escaped.credentials()
        await applicationGate // Deliberately not an abortable application Promise.
        applicationContinued = true
        callbackDone()
      }, { signal: controller.signal })
      await ready
      controller.abort()
      await expect(invocation).rejects.toBeDefined()
      expect(finalized).toBe(true)
      expect(applicationContinued).toBe(false)
      await expect(escaped.inspect()).rejects.toBeInstanceOf(ClientDisposed)
      release()
      await callbackFinished
      expect(applicationContinued).toBe(true)
      await expect(escaped.credentials()).rejects.toBeInstanceOf(ClientDisposed)
      // Interruption is not permission to release ambiguous refresh ownership.
      expect((await ctx.runQuery(refs.read, { key: 'abort' }))!.owner).not.toBeNull()
    })
  })

  test.each([false, true])('keeps scoped children alive until callback exit and awaits cleanup: failure=%s', async (fail) => {
    const { t, store } = setup()
    const base = makeManager({ store, refresh: noRefresh })
    let started!: () => void
    const ready = new Promise<void>((resolve) => { started = resolve })
    let finalized = false
    const manager = { connection: (key: string) => ({
      ...base.connection(key),
      credentials: () => Effect.gen(function* () {
        yield* Effect.forkScoped(Effect.gen(function* () {
          yield* Effect.addFinalizer(() => Effect.sleep('5 millis').pipe(Effect.andThen(Effect.sync(() => { finalized = true }))))
          started()
          yield* Effect.never
        }))
        return yield* base.connection(key).credentials()
      }),
    }) }
    await t.action(async (ctx) => {
      await Convex.run(ctx, store.initialize('child', tokens('FAKE-current', Date.now() + 60_000)))
      const callbackError = new Error('callback failure')
      const invocation = Convex.withClient(ctx, manager, async (client) => {
        await client.connection('child').credentials()
        await ready
        expect(finalized).toBe(false)
        if (fail) throw callbackError
      })
      if (fail) await expect(invocation).rejects.toBe(callbackError)
      else await invocation
      expect(finalized).toBe(true)
    })
  })

  test.each([false, true])('interrupts unawaited library work and awaits its finalizer on callback failure=%s', async (fail) => {
    const { t, store } = setup()
    let started!: () => void
    const ready = new Promise<void>((resolve) => { started = resolve })
    let finalized = false
    const manager = makeManager({ store, refresh: () => Effect.gen(function* () {
      yield* Effect.addFinalizer(() => Effect.sync(() => { finalized = true }))
      started()
      return yield* Effect.never
    }).pipe(Effect.scoped) })
    await t.action(async (ctx) => {
      await Convex.run(ctx, store.initialize('cleanup', tokens()))
      let work!: Promise<unknown>
      const callbackError = new Error('callback failure')
      const invocation = Convex.withClient(ctx, manager, async (client) => {
        work = client.connection('cleanup').credentials()
        await ready
        if (fail) throw callbackError
        return 'done'
      })
      if (fail) await expect(invocation).rejects.toBe(callbackError)
      else expect(await invocation).toBe('done')
      expect(finalized).toBe(true)
      await expect(work).rejects.toBeDefined()
    })
  })
})

describe('adapter completion acknowledgement loss, not just direct mutation replay', () => {
  test('successful refresh after the last polling iteration is re-read, not reported as pending', async () => {
    const { t, store: base } = setup()
    let reads = 0
    let exchanges = 0
    const store = { ...base, read: (key: string) => base.read(key).pipe(Effect.map((record) => {
      reads++
      // Deterministic observations: 99 pending reads, then an available record.
      return reads < 100 && record ? { ...record, owner: 'another-worker' } : record
    })) }
    const manager = makeManager({ store, refresh: () => Effect.sync(() => {
      exchanges++
      return tokens('FAKE-after-wait', Date.now() + 60_000)
    }) })
    await t.action(async (ctx) => {
      await Convex.run(ctx, base.initialize('wait-boundary', tokens()))
      const result = await Convex.withClient(ctx, manager, (client) => client.connection('wait-boundary').credentials())
      expect(Redacted.value(result.accessToken)).toBe('FAKE-after-wait')
      expect(reads).toBe(101)
      expect(exchanges).toBe(1)
    })
  })

  test('persists an already-expired replacement without looping provider exchanges', async () => {
    const { t, store } = setup()
    let exchanges = 0
    const manager = makeManager({ store, refresh: () => Effect.sync(() => {
      exchanges++
      return { ...tokens('FAKE-expired'), refreshToken: Redacted.make('FAKE-rotated') }
    }) })
    await t.action(async (ctx) => {
      await Convex.run(ctx, store.initialize('expired-result', tokens()))
      await expect(Convex.withClient(ctx, manager, (client) => client.connection('expired-result').credentials()))
        .rejects.toBeInstanceOf(ProviderError)
      expect(exchanges).toBe(1)
      const record = await ctx.runQuery(refs.read, { key: 'expired-result' })
      expect(Redacted.value((await Convex.run(ctx, store.decrypt(record!))).refreshToken)).toBe('FAKE-rotated')
    })
  })

  test.each(['replay', 'newer-authorization', 'exhausted'] as const)('immutable retry through manager: %s', async (scenario) => {
    const { t } = setup()
    let encryptions = 0
    const cipher = AesGcm.make(() => fakeKey)
    const store = Convex.store({ component: components.credentialStore, encryptor: {
      ...cipher,
      encrypt: (key, value) => Effect.suspend(() => { encryptions++; return cipher.encrypt(key, value) }),
    } })
    type Completion = FunctionArgs<typeof refs.complete>
    const sent: Completion[] = []
    const payloadObjects: unknown[] = []
    const statuses: string[] = []
    let exchangeAttempts = 0
    await t.action(async (ctx) => {
      const manager = makeManager({ store, refresh: (key, refreshToken) => Effect.tryPromise({
        try: async () => {
          exchangeAttempts++
          const next = await ctx.runMutation(refs.fakeExchange, { key, refreshToken: Redacted.value(refreshToken) })
          return { ...next, accessToken: Redacted.make(next.accessToken), refreshToken: Redacted.make(next.refreshToken) }
        }, catch: () => new ProviderError(),
      }) })
      await Convex.run(ctx, store.initialize('ack', tokens()))
      encryptions = 0
      const lossy: Parameters<typeof Convex.layer>[0] = {
        runQuery: ctx.runQuery,
        runMutation: async (ref, ...args) => {
          const isComplete = JSON.stringify(getFunctionAddress(ref)) === JSON.stringify(getFunctionAddress(refs.complete))
          if (isComplete) {
            sent.push(structuredClone(args[0]) as Completion)
            payloadObjects.push(args[0])
          }
          const result = await ctx.runMutation(ref, ...args)
          if (isComplete) {
            statuses.push((result as { status: string }).status)
            if (sent.length === 1 && scenario === 'newer-authorization') {
              // A newer stored authorization is simulated with existing claim +
              // completion, NOT a claim of full enrollment/replacement support.
              const row = await ctx.runQuery(refs.read, { key: 'ack' })
              const claim = await ctx.runMutation(refs.claim, { key: 'ack', expectedVersion: row!.version, owner: 'newer', leaseMs: 5_000 })
              if (!claim.claimed) throw new Error('Expected newer claim')
              await Convex.run(ctx, store.complete('ack', 'newer', claim.fence, tokens('FAKE-newer-authorization', Date.now() + 60_000)))
            }
            if (sent.length === 1 || scenario === 'exhausted') throw new Error('Injected AFTER APPLY response loss')
          }
          return result
        },
      }
      const completion = Convex.withClient(lossy, manager, (client) => client.connection('ack').credentials())
      if (scenario === 'replay') expect(Redacted.value((await completion).accessToken)).toBe('FAKE-access-1')
      else await expect(completion).rejects.toBeInstanceOf(StoreError)
      expect(sent).toHaveLength(2)
      expect(sent[1]).toEqual(sent[0]) // includes IV, ciphertext, expiry, owner, fence, writeId
      expect(payloadObjects[1]).toBe(payloadObjects[0])
      expect(encryptions).toBe(scenario === 'newer-authorization' ? 2 : 1)
      expect(statuses).toEqual(['committed', scenario === 'newer-authorization' ? 'conflict' : 'already-applied'])
      expect(exchangeAttempts).toBe(1)
      expect(await ctx.runQuery(refs.providerCalls, { key: 'ack' })).toBe(1)
      const row = await ctx.runQuery(refs.read, { key: 'ack' })
      expect(row!.version).toBe(scenario === 'newer-authorization' ? 4 : 2)
      const stored = await Convex.run(ctx, store.decrypt(row!))
      expect(Redacted.value(stored.accessToken)).toBe(scenario === 'newer-authorization' ? 'FAKE-newer-authorization' : 'FAKE-access-1')
      // A later invocation reads committed state even when both acks were lost.
      await Convex.withClient(ctx, manager, (client) => client.connection('ack').credentials())
      expect(exchangeAttempts).toBe(1)
    })
  })
})
