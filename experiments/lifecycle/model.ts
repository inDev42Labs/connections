// THROWAWAY contract experiment. All times are fake store-clock milliseconds.
import { Context, Data, Effect, Redacted } from 'effect'

export class Fault extends Data.TaggedError('LifecycleFault')<{
  readonly code: 'conflict' | 'busy' | 'missing' | 'attention' | 'unknown' | 'ack-lost' | 'stopped' | 'invalid-attempt'
}> {}
export const fail = (code: Fault['code']): never => { throw new Fault({ code }) }
export const atomic = <A>(body: () => A): Effect.Effect<A, Fault> => Effect.try({
  try: body,
  catch: (error) => { if (error instanceof Fault) return error; throw error },
})
export interface Tokens { readonly access: string; readonly refresh: string; readonly expires: number; readonly refreshExpires: number }
export type Policy = { readonly kind: 'strict' } | { readonly kind: 'reusable' } | { readonly kind: 'conditional'; readonly window: number }
export interface Ticket { readonly operation: number; readonly generation: number; readonly fence: number }
export interface Operation {
  readonly id: number
  readonly generation: number
  readonly policy: Policy
  readonly maxSends: number
  readonly firstSend: number | null
  readonly sends: number
  readonly staged: Tokens | null
  readonly attention: boolean
  readonly done: boolean
  readonly owner: { readonly fence: number; readonly until: number } | null
}
export interface Snapshot {
  readonly id: string
  readonly generation: number
  readonly revision: number
  readonly now: number
  readonly tokens: Tokens | null
  readonly pendingAuthorization: string | null
  readonly authorizationExchange: string | null
  readonly authorizationUntil: number | null
  readonly operation: Operation | null
}
export interface Inspection {
  readonly id: string
  readonly saved: boolean
  readonly pendingAuthorization: boolean
  readonly unresolved: boolean
  readonly attention: boolean
}
export interface Attempt {
  readonly id: string
  readonly generation: number
  readonly binding: string
  readonly intent: 'enroll' | 'replace'
  readonly expires: number
}
// Invocation identity is internal, never supplied by the browser or reused by a new workflow.
export interface AuthorizationReservation extends Attempt {
  readonly invocation: string
  readonly until: number
}
export type Progress =
  | { readonly kind: 'send'; readonly expectedSends: number; readonly notAfter: number }
  | { readonly kind: 'stage'; readonly tokens: Tokens }
  | { readonly kind: 'attention' }

export class InspectionStore extends Context.Service<InspectionStore, {
  readonly inspect: () => Effect.Effect<Inspection, Fault>
}>()('experiment/lifecycle/InspectionStore') {}

export class Store extends Context.Service<Store, {
  readonly read: () => Effect.Effect<Snapshot, Fault>
  readonly inspect: () => Effect.Effect<Inspection, Fault>
  readonly claim: (request: string, revision: number, policy: Policy, maxSends: number) => Effect.Effect<Ticket, Fault>
  readonly renew: (ticket: Ticket, request: string) => Effect.Effect<void, Fault>
  readonly checkpoint: (ticket: Ticket, request: string, progress: Progress) => Effect.Effect<void, Fault>
  readonly complete: (ticket: Ticket, request: string) => Effect.Effect<void, Fault>
  readonly start: (request: string, binding: string, intent: Attempt['intent']) => Effect.Effect<Attempt, Fault>
  readonly consume: (request: string, id: string, binding: string) => Effect.Effect<AuthorizationReservation, Fault>
  readonly authorize: (attempt: AuthorizationReservation, tokens: Tokens) => Effect.Effect<void, Fault>
  readonly remove: (request: string, generation: number) => Effect.Effect<void, Fault>
}>()('experiment/lifecycle/Store') {}
export class Provider extends Context.Service<Provider, {
  readonly policy: Policy
  readonly refresh: (tokens: Tokens) => Effect.Effect<Tokens, Fault>
  readonly exchange: () => Effect.Effect<Tokens, Fault>
}>()('experiment/lifecycle/Provider') {}

// Test-only interruption seams, not a second workflow or public API.
export type Point = 'claimed' | 'reserved' | 'response' | 'staged' | 'authorization-reserved' | 'authorization-response'
export class Worker extends Context.Service<Worker, {
  readonly request: () => string
  readonly at: (point: Point) => Effect.Effect<void, Fault>
}>()('experiment/lifecycle/Worker') {}

const retryWrite = <A, R>(effect: Effect.Effect<A, Fault, R>) => effect.pipe(
  Effect.retry({ times: 2, while: (error) => error.code === 'ack-lost' }),
)
function replayAllowed(op: Operation, tokens: Tokens, now: number) {
  if (now >= tokens.refreshExpires || op.sends >= op.maxSends) return false
  if (op.firstSend === null) return true
  if (now < op.firstSend) return false
  if (op.policy.kind === 'strict') return false
  return op.policy.kind === 'reusable' || now - op.firstSend < op.policy.window
}

// No runtime creation, local lock, token cache, or provider retry loop outside this workflow.
export function makeManager() {
  return {
    inspect: () => Effect.flatMap(InspectionStore, (store) => store.inspect()),
    credentials: (): Effect.Effect<{ accessToken: Redacted.Redacted<string> }, Fault, Store | Provider | Worker> => Effect.gen(function* () {
      const store = yield* Store
      const provider = yield* Provider
      const worker = yield* Worker
      const initial = yield* store.read()
      if (initial.authorizationExchange) return yield* Effect.fail(new Fault({
        code: initial.authorizationUntil !== null && initial.now < initial.authorizationUntil ? 'busy' : 'attention',
      }))
      if (!initial.tokens) return yield* Effect.fail(new Fault({ code: 'missing' }))
      if ((!initial.operation || initial.operation.done) && initial.tokens.expires > initial.now) {
        return { accessToken: Redacted.make(initial.tokens.access) }
      }
      const ticket = yield* retryWrite(store.claim(worker.request(), initial.revision, provider.policy, 3))
      yield* worker.at('claimed')
      for (;;) {
        yield* retryWrite(store.renew(ticket, worker.request()))
        const current = yield* store.read()
        const op = current.operation
        if (!op || !current.tokens || op.id !== ticket.operation) return yield* Effect.fail(new Fault({ code: 'conflict' }))
        if (op.staged) {
          yield* retryWrite(store.complete(ticket, worker.request()))
          const saved = yield* store.read()
          if (saved.generation !== ticket.generation || saved.operation?.id !== ticket.operation || !saved.tokens) {
            return yield* Effect.fail(new Fault({ code: 'conflict' }))
          }
          // Staged refresh credentials may still recover even if their access token aged out.
          if (saved.tokens.expires <= saved.now) return yield* makeManager().credentials()
          return { accessToken: Redacted.make(saved.tokens.access) }
        }
        if (op.attention || !replayAllowed(op, current.tokens, current.now)) {
          yield* retryWrite(store.checkpoint(ticket, worker.request(), { kind: 'attention' }))
          return yield* Effect.fail(new Fault({ code: 'attention' }))
        }
        // Persist a conservative possible-send marker BEFORE contacting the provider.
        const notAfter = op.policy.kind === 'conditional' && op.firstSend !== null
          ? Math.min(current.tokens.refreshExpires, op.firstSend + op.policy.window)
          : current.tokens.refreshExpires
        yield* retryWrite(store.checkpoint(ticket, worker.request(), { kind: 'send', expectedSends: op.sends, notAfter }))
        yield* worker.at('reserved')
        // Recheck ownership immediately before dispatch. Still not atomic with remote IO.
        yield* retryWrite(store.renew(ticket, worker.request()))
        if ((yield* store.read()).now >= notAfter) {
          yield* retryWrite(store.checkpoint(ticket, worker.request(), { kind: 'attention' }))
          return yield* Effect.fail(new Fault({ code: 'attention' }))
        }
        const response = yield* provider.refresh(current.tokens)
        yield* worker.at('response')
        yield* retryWrite(store.checkpoint(ticket, worker.request(), { kind: 'stage', tokens: response }))
        yield* worker.at('staged')
      }
    }),
    startAuthorization: (binding: string, intent: Attempt['intent'] = 'enroll') => Effect.gen(function* () {
      const store = yield* Store
      const worker = yield* Worker
      return yield* retryWrite(store.start(worker.request(), binding, intent))
    }),
    completeAuthorization: (id: string, binding: string) => Effect.gen(function* () {
      const store = yield* Store
      const provider = yield* Provider
      const worker = yield* Worker
      // Retry only this pre-dispatch mutation, never the provider call or whole callback.
      const attempt = yield* retryWrite(store.consume(worker.request(), id, binding))
      yield* worker.at('authorization-reserved')
      const current = yield* store.read()
      if (current.generation !== attempt.generation || current.authorizationExchange !== attempt.id
        || current.now >= attempt.until) {
        return yield* Effect.fail(new Fault({ code: 'conflict' }))
      }
      const tokens = yield* provider.exchange()
      yield* worker.at('authorization-response')
      yield* retryWrite(store.authorize(attempt, tokens))
      return { id: (yield* store.inspect()).id }
    }),
    remove: () => Effect.gen(function* () {
      const store = yield* Store
      const worker = yield* Worker
      yield* retryWrite(store.remove(worker.request(), (yield* store.read()).generation))
    }),
  }
}
