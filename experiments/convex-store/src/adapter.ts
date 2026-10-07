// THROWAWAY: an app-side adapter, not a package export or complete OAuth store.
import { Cause, Context, Data, Effect, Exit, Fiber, Layer, Redacted, Schema, Scope } from 'effect'
import type { FunctionReturnType, GenericActionCtx, GenericDataModel } from 'convex/server'
import type { ComponentApi } from './component/_generated/component'

type QueryContext = Pick<GenericActionCtx<GenericDataModel>, 'runQuery'>
type InvocationContext = Pick<GenericActionCtx<GenericDataModel>, 'runQuery' | 'runMutation'>
export class QueryInvocation extends Context.Service<QueryInvocation, QueryContext>()('prototype/convex/QueryInvocation') {}
export class ClientDisposed extends Data.TaggedError('ClientDisposed')<{}> {}

// Intentionally not a provider-health verdict or lifecycle state machine.
export type Inspection = { savedAuthorization: boolean; credentialWorkPending: boolean }
type Inspectable = { inspect: () => Effect.Effect<Inspection, StoreError, QueryInvocation> }
type Connection<A, E> = Inspectable & {
  credentials: () => Effect.Effect<A, E, Invocation | QueryInvocation | Scope.Scope>
}
type Manager<A, E> = { connection: (key: string) => Connection<A, E> }
export type PromiseConnection<A> = { credentials: () => Promise<A>; inspect: () => Promise<Inspection> }

type RunOptions = { readonly signal?: AbortSignal }
async function structuredPromise<A, E>(effect: Effect.Effect<A, E>, options?: RunOptions): Promise<A> {
  const exit = await Effect.runPromiseExit(effect, options)
  if (Exit.isSuccess(exit)) return exit.value
  // Squash preserves a typed failure value (and raw defects), not FiberFailure.
  throw Cause.squash(exit.cause)
}
export class Invocation extends Context.Service<Invocation, InvocationContext>()('prototype/convex/Invocation') {}
export class StoreError extends Data.TaggedError('StoreError')<{}> {}
export class CipherError extends Data.TaggedError('CipherError')<{}> {}
export class RefreshPending extends Data.TaggedError('RefreshPending')<{}> {}
export class ProviderError extends Data.TaggedError('ProviderError')<{}> {}

type StoredRecord = NonNullable<FunctionReturnType<ComponentApi['records']['read']>>
export type Envelope = StoredRecord['envelope']

const TokenSchema = Schema.Struct({
  accessToken: Schema.RedactedFromValue(Schema.String),
  refreshToken: Schema.RedactedFromValue(Schema.String),
  expiresAt: Schema.Number,
})
export type Tokens = typeof TokenSchema.Type

const invoke = <A>(f: (ctx: InvocationContext) => Promise<A>) => Effect.gen(function* () {
  const ctx = yield* Invocation
  return yield* Effect.tryPromise({ try: () => f(ctx), catch: () => new StoreError() })
})

export const AesGcm = {
  make: (getBase64Key: () => string | undefined) => {
    const key = () => {
      const encoded = getBase64Key()
      if (encoded === undefined) throw new Error('Missing fixture key')
      const bytes = Uint8Array.from(atob(encoded), (c) => c.charCodeAt(0))
      if (bytes.length !== 32) throw new Error('Expected a 256-bit key')
      return crypto.subtle.importKey('raw', bytes, 'AES-GCM', false, ['encrypt', 'decrypt'])
    }
    const additionalData = (recordKey: string, expiresAt: number) =>
      new TextEncoder().encode(JSON.stringify([recordKey, expiresAt]))
    return {
      encrypt: (recordKey: string, tokens: Tokens) => Effect.tryPromise({
        try: async (): Promise<Envelope> => {
          const iv = crypto.getRandomValues(new Uint8Array(12))
          const plaintext = JSON.stringify({
            accessToken: Redacted.value(tokens.accessToken),
            refreshToken: Redacted.value(tokens.refreshToken),
            expiresAt: tokens.expiresAt,
          })
          const ciphertext = await crypto.subtle.encrypt(
            { name: 'AES-GCM', iv, additionalData: additionalData(recordKey, tokens.expiresAt) },
            await key(),
            new TextEncoder().encode(plaintext),
          )
          return { iv: iv.buffer, ciphertext, format: 'aes-gcm-v1' }
        },
        catch: () => new CipherError(),
      }),
      decrypt: (recordKey: string, expiresAt: number, envelope: Envelope) => Effect.gen(function* () {
        const raw = yield* Effect.tryPromise({
          try: async (): Promise<unknown> => {
            const plaintext = await crypto.subtle.decrypt(
              { name: 'AES-GCM', iv: envelope.iv, additionalData: additionalData(recordKey, expiresAt) },
              await key(),
              envelope.ciphertext,
            )
            return JSON.parse(new TextDecoder().decode(plaintext))
          },
          catch: () => new CipherError(),
        })
        return yield* Schema.decodeUnknownEffect(TokenSchema)(raw).pipe(Effect.mapError(() => new CipherError()))
      }),
    }
  },
}

export const Convex = {
  layer: (ctx: InvocationContext) => Layer.merge(Layer.succeed(Invocation, ctx), Layer.succeed(QueryInvocation, ctx)),
  run: <A, E>(ctx: InvocationContext, program: Effect.Effect<A, E, Invocation | QueryInvocation | Scope.Scope>, options?: RunOptions) =>
    structuredPromise(Effect.scoped(program.pipe(Effect.provide(Convex.layer(ctx)))), options),
  inspect: (ctx: QueryContext, connection: Inspectable) =>
    structuredPromise(connection.inspect().pipe(Effect.provideService(QueryInvocation, ctx))),
  // One callback owns all library fibers. It cannot cancel arbitrary app Promises
  // or recall already-dispatched mutations. Escaped handles always fail closed.
  withClient: <A, E, B>(ctx: InvocationContext, manager: Manager<A, E>,
    use: (client: { connection: (key: string) => PromiseConnection<A> }) => Promise<B>, options?: RunOptions): Promise<B> =>
    Convex.run(ctx, Effect.gen(function* () {
      const scope = yield* Scope.Scope
      let active = true
      const run = <Value, Error>(program: Effect.Effect<Value, Error, Invocation | QueryInvocation | Scope.Scope>): Promise<Value> => {
        if (!active) return Promise.reject(new ClientDisposed())
        const promise = structuredPromise(program.pipe(
          Effect.provide(Convex.layer(ctx)), Effect.provideService(Scope.Scope, scope),
          Effect.forkIn(scope), Effect.flatMap(Fiber.join),
        ))
        // Observe abandoned library rejections without changing awaited results.
        void promise.catch(() => undefined)
        return promise
      }
      return yield* Effect.tryPromise({
        try: () => use({ connection: (key) => {
          const connection = manager.connection(key)
          return { credentials: () => run(connection.credentials()), inspect: () => run(connection.inspect()) }
        } }),
        catch: (error) => error,
      }).pipe(Effect.ensuring(Effect.sync(() => { active = false })))
    }), options),
  store: (component: ComponentApi, { encryptor }: { encryptor: ReturnType<typeof AesGcm.make> }) => ({
    initialize: (key: string, tokens: Tokens) => Effect.gen(function* () {
      const envelope = yield* encryptor.encrypt(key, tokens)
      return yield* invoke((ctx) => ctx.runMutation(component.records.initialize, { key, envelope, expiresAt: tokens.expiresAt }))
    }),
    read: (key: string) => invoke((ctx) => ctx.runQuery(component.records.read, { key })),
    inspect: (key: string) => Effect.gen(function* () {
      const ctx = yield* QueryInvocation
      // The component projects metadata; no encrypted credential payload even
      // crosses into the parent query. No key resolution or mutation capability.
      return yield* Effect.tryPromise({
        try: () => ctx.runQuery(component.records.inspect, { key }), catch: () => new StoreError(),
      })
    }),
    decrypt: (record: StoredRecord) => encryptor.decrypt(record.key, record.expiresAt, record.envelope),
    claim: (key: string, expectedVersion: number, owner: string) =>
      invoke((ctx) => ctx.runMutation(component.records.claim, { key, expectedVersion, owner, leaseMs: 5_000 })),
    complete: (key: string, owner: string, fence: number, tokens: Tokens) => Effect.gen(function* () {
      // Prepare once per completion; retry ONLY the immutable storage mutation.
      // This bounded retry survives ack loss in this invocation, not worker death.
      // Encryption is outside the mutation; ciphertext never contains the raw key.
      const envelope = yield* encryptor.encrypt(key, tokens)
      const writeId = crypto.randomUUID()
      const payload = { key, owner, fence, writeId, envelope, expiresAt: tokens.expiresAt }
      const result = yield* invoke((ctx) => ctx.runMutation(component.records.complete, payload)).pipe(
        Effect.retry({ times: 1 }),
      )
      if (result.status === 'conflict') return yield* Effect.fail(new StoreError())
    }),
  }),
}

export function makeManager(options: {
  store: ReturnType<typeof Convex.store>
  refresh: (key: string, refreshToken: Redacted.Redacted<string>) => Effect.Effect<Tokens, ProviderError>
}) {
  return {
    connection: (key: string) => ({
      inspect: () => options.store.inspect(key),
      credentials: () => Effect.gen(function* () {
        let waits = 0
        let refreshed = false
        for (;;) {
          const record = yield* options.store.read(key)
          if (record === null) return yield* Effect.fail(new StoreError())
          // No takeover/recovery is implemented by this bounded integration probe.
          if (record.owner !== null) {
            if (waits++ >= 100) return yield* Effect.fail(new RefreshPending())
            yield* Effect.sleep('10 millis')
            continue
          }
          const tokens = yield* options.store.decrypt(record)
          if (record.expiresAt > Date.now()) return { accessToken: tokens.accessToken }
          // Preserve a rotated response, but do not loop exchanges indefinitely
          // if this probe's provider returned an already-expired access token.
          if (refreshed) return yield* Effect.fail(new ProviderError())
          const owner = crypto.randomUUID()
          const claim = yield* options.store.claim(key, record.version, owner)
          if (!claim.claimed) {
            if (waits++ >= 100) return yield* Effect.fail(new RefreshPending())
            yield* Effect.sleep('10 millis')
            continue
          }
          const next = yield* options.refresh(key, tokens.refreshToken)
          yield* options.store.complete(key, owner, claim.fence, next)
          refreshed = true
          // Successful work does not consume the wait budget: re-read even
          // when ownership became available on the final waiting iteration.
        }
      }),
    }),
  }
}

export function fakeHttpRefresh(getUrl: () => string) {
  return (key: string, refreshToken: Redacted.Redacted<string>) => Effect.gen(function* () {
    const raw = yield* Effect.tryPromise({
      try: async (signal): Promise<unknown> => {
        const url = new URL('/fake-oauth', getUrl())
        if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) throw new Error('Local provider only')
        const response = await fetch(url, {
          method: 'POST', signal, redirect: 'error',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ key, refreshToken: Redacted.value(refreshToken) }),
        })
        if (!response.ok) throw new Error('Fake provider rejected exchange')
        return await response.json()
      },
      catch: () => new ProviderError(),
    })
    return yield* Schema.decodeUnknownEffect(TokenSchema)(raw).pipe(Effect.mapError(() => new ProviderError()))
  })
}
