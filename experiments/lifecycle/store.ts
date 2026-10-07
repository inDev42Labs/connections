// FAKE STORAGE: synchronous JS mutations stand in for serializable transactions.
// The backend outlives clients/runtimes, NOT this OS process. Plain fake tokens.
import { atomic, fail } from './model'
import type { AuthorizationReservation, Attempt, Operation, Snapshot, Store, Ticket, Tokens } from './model'

type Mutable<T> = { -readonly [K in keyof T]: T[K] }
type Receipt = { fingerprint: string; value: unknown }
const copy = <T>(value: T): T => structuredClone(value)
export const LEASE = 10

export class FakeDatabase {
  now = 100
  private generation = 0
  private revision = 0
  private serial = 0
  private tokens: Tokens | null
  private pending: string | null = null
  private exchange: string | null = null
  private active: number | null = null
  private readonly operations = new Map<number, Mutable<Operation>>()
  private readonly receipts = new Map<string, Receipt>()
  private readonly attempts = new Map<string, Attempt & { consumed: boolean; reservation?: AuthorizationReservation; result: string | null }>()
  private readonly lost = new Map<string, number>()
  mutations = 0
  constructor(tokens: Tokens | null) { this.tokens = copy(tokens) }
  // Test-only JSON roundtrip, not a production schema or inspection API.
  exportState() {
    return copy({ now: this.now, generation: this.generation, revision: this.revision, serial: this.serial,
      tokens: this.tokens, pending: this.pending, exchange: this.exchange, active: this.active,
      operations: [...this.operations], receipts: [...this.receipts], attempts: [...this.attempts],
      lost: [...this.lost], mutations: this.mutations })
  }
  static restoreState(state: ReturnType<FakeDatabase['exportState']>): FakeDatabase {
    const s = copy(state)
    const db = new FakeDatabase(s.tokens)
    db.now = s.now; db.generation = s.generation; db.revision = s.revision; db.serial = s.serial
    db.pending = s.pending; db.exchange = s.exchange; db.active = s.active; db.mutations = s.mutations
    for (const [k, v] of s.operations) db.operations.set(k, v)
    for (const [k, v] of s.receipts) db.receipts.set(k, v)
    for (const [k, v] of s.attempts) db.attempts.set(k, v)
    for (const [k, v] of s.lost) db.lost.set(k, v)
    return db
  }
  advance(ms: number) { if (ms < 0) throw new Error('Fake clock is monotonic'); this.now += ms }
  loseNextAck(method: string) { this.lost.set(method, (this.lost.get(method) ?? 0) + 1) }
  private changed() { this.revision++; this.mutations++ }
  private acknowledged(method: string) {
    const remaining = this.lost.get(method) ?? 0
    if (remaining > 0) { this.lost.set(method, remaining - 1); fail('ack-lost') }
  }
  // Payload equality is mandatory: a reused key with different input is not a retry.
  private receipt<A>(method: string, key: string, input: unknown): { found: false } | { found: true; value: A } {
    const receipt = this.receipts.get(`${method}:${key}`)
    if (!receipt) return { found: false }
    if (receipt.fingerprint !== JSON.stringify(input)) fail('conflict')
    return { found: true, value: copy(receipt.value as A) }
  }
  private remember(method: string, key: string, input: unknown, value: unknown) {
    this.receipts.set(`${method}:${key}`, { fingerprint: JSON.stringify(input), value: copy(value) })
  }
  private current() { return this.active === null ? undefined : this.operations.get(this.active) }
  private owned(ticket: Ticket): Mutable<Operation> {
    const op = this.current()
    if (!op || op.id !== ticket.operation || this.generation !== ticket.generation || op.done
      || op.owner?.fence !== ticket.fence || op.owner.until <= this.now) return fail('conflict')
    return op
  }
  private preparation(): string | null {
    const attempt = this.pending === null ? undefined : this.attempts.get(this.pending)
    return attempt && !attempt.consumed && attempt.expires > this.now ? attempt.id : null
  }
  private exchangeUntil(): number | null {
    return this.exchange === null ? null : this.attempts.get(this.exchange)?.reservation?.until ?? null
  }
  private exchangeActive(): boolean { return (this.exchangeUntil() ?? 0) > this.now }
  snapshot(): Snapshot {
    return copy({ id: 'workspace-crm', generation: this.generation, revision: this.revision, now: this.now,
      tokens: this.tokens, pendingAuthorization: this.preparation(), authorizationExchange: this.exchange, authorizationUntil: this.exchangeUntil(),
      operation: this.current() ?? null })
  }
  // Test-only evidence; deliberately NOT an inspection endpoint.
  history(): readonly Operation[] { return copy([...this.operations.values()]) }

  client(): Store['Service'] {
    return {
      read: () => atomic(() => this.snapshot()),
      inspect: () => atomic(() => ({ id: 'workspace-crm', saved: this.tokens !== null,
        pendingAuthorization: this.preparation() !== null,
        unresolved: this.exchange !== null || (!!this.current() && !this.current()!.done),
        attention: (this.exchange !== null && !this.exchangeActive()) || (this.current()?.attention ?? false) })),
      claim: (request, revision, policy, maxSends) => atomic(() => {
        const input = { revision, policy, maxSends }
        const receipt = this.receipt<Ticket>('claim', request, input)
        if (receipt.found) {
          // A lost response never becomes a new acquisition, even after expiry.
          this.owned(receipt.value)
          return receipt.value
        }
        if (revision !== this.revision || this.exchange) return fail('conflict')
        if (!this.tokens) return fail('missing')
        let op = this.current()
        if (op && !op.done && op.owner && op.owner.until > this.now) return fail('busy')
        if (!op || op.done) {
          op = { id: ++this.serial, generation: this.generation, policy: copy(policy), maxSends,
            firstSend: null, sends: 0, staged: null, attention: false, done: false, owner: null }
          this.operations.set(op.id, op)
          this.active = op.id
        }
        // Existing history AND policy/budget survive transfer; caller config cannot reset them.
        const ticket = { operation: op.id, generation: this.generation, fence: ++this.serial }
        op.owner = { fence: ticket.fence, until: this.now + LEASE }
        this.changed()
        this.remember('claim', request, input, ticket)
        this.acknowledged('claim')
        return copy(ticket)
      }),
      renew: (ticket, request) => atomic(() => {
        const op = this.owned(ticket)
        if (this.receipt('renew', request, ticket).found) return
        op.owner = { fence: ticket.fence, until: this.now + LEASE }
        this.changed()
        this.remember('renew', request, ticket, null)
        this.acknowledged('renew')
      }),
      checkpoint: (ticket, request, progress) => atomic(() => {
        const op = this.owned(ticket)
        const input = { ticket, progress }
        if (this.receipt('checkpoint', request, input).found) return
        switch (progress.kind) {
          case 'send':
            if (op.staged || op.attention || progress.expectedSends !== op.sends || op.sends >= op.maxSends
              || this.now >= progress.notAfter) return fail('conflict')
            op.firstSend ??= this.now
            op.sends++
            break
          case 'stage':
            if (op.sends === 0 || op.staged || op.attention) return fail('conflict')
            op.staged = copy(progress.tokens)
            break
          case 'attention': op.attention = true; break
        }
        this.changed()
        this.remember('checkpoint', request, input, null)
        this.acknowledged('checkpoint')
      }),
      complete: (ticket, request) => atomic(() => {
        const receipt = this.receipt('complete', request, ticket)
        if (receipt.found) {
          if (this.generation !== ticket.generation || this.current()?.id !== ticket.operation) return fail('conflict')
          return
        }
        const op = this.owned(ticket)
        if (!op.staged) return fail('conflict')
        this.tokens = copy(op.staged)
        op.done = true
        op.owner = null
        this.changed()
        this.remember('complete', request, ticket, null)
        this.acknowledged('complete')
      }),
      start: (request, binding, intent) => atomic(() => {
        const input = { binding, intent }
        const receipt = this.receipt<Attempt>('start', request, input)
        if (receipt.found) {
          if (receipt.value.generation !== this.generation || this.preparation() !== receipt.value.id) return fail('conflict')
          return receipt.value
        }
        if (this.exchange) return fail(this.exchangeActive() ? 'busy' : 'attention')
        if (intent === 'enroll' && (this.tokens || this.preparation())) return fail('conflict')
        // Browser preparation has no remote credential effects in this fake contract.
        // Supersede only the previous page, not the current credential/refresh lifecycle.
        const attempt: Attempt = { id: `attempt-${++this.serial}`, generation: this.generation,
          binding, intent, expires: this.now + 100 }
        this.pending = attempt.id
        this.attempts.set(attempt.id, { ...attempt, consumed: false, result: null })
        this.changed()
        this.remember('start', request, input, attempt)
        this.acknowledged('start')
        return copy(attempt)
      }),
      consume: (request, id, binding) => atomic(() => {
        const input = { id, binding }
        const receipt = this.receipt<AuthorizationReservation>('consume', request, input)
        if (receipt.found) {
          const reservation = receipt.value
          if (this.exchange !== id || this.generation !== reservation.generation
            || reservation.until <= this.now
            || JSON.stringify(this.attempts.get(id)?.reservation) !== JSON.stringify(reservation)) return fail('conflict')
          return reservation
        }
        const attempt = this.attempts.get(id)
        if (!attempt || attempt.consumed || attempt.binding !== binding || attempt.expires <= this.now
          || attempt.generation !== this.generation || this.pending !== id) return fail('invalid-attempt')
        if (this.exchange) return fail(this.exchangeActive() ? 'busy' : 'attention')
        const op = this.current()
        // Even expired ownership cannot prove an unresolved remote refresh has stopped.
        if (op && !op.done) return fail(op.attention ? 'attention' : 'busy')
        const reserved: AuthorizationReservation = { id: attempt.id, binding: attempt.binding, intent: attempt.intent,
          expires: attempt.expires, generation: ++this.generation, invocation: request, until: this.now + LEASE }
        this.attempts.set(id, { ...attempt, generation: reserved.generation, consumed: true, reservation: reserved })
        this.active = null // Only completed refresh history can be detached here.
        this.exchange = id // Durable possible-send evidence, independent of browser expiry.
        this.changed()
        this.remember('consume', request, input, reserved)
        this.acknowledged('consume')
        return copy(reserved)
      }),
      authorize: (attempt, tokens) => atomic(() => {
        const stored = this.attempts.get(attempt.id)
        if (!stored || !stored.consumed || stored.generation !== this.generation
          || attempt.generation !== stored.generation
          || JSON.stringify(stored.reservation) !== JSON.stringify(attempt)) return fail('conflict')
        if (stored.result !== null) {
          if (stored.result !== JSON.stringify(tokens)) return fail('conflict')
          return
        }
        if (this.pending !== attempt.id) return fail('conflict')
        stored.result = JSON.stringify(tokens)
        this.tokens = copy(tokens)
        this.pending = null
        this.exchange = null
        this.changed()
        this.acknowledged('authorize')
      }),
      remove: (request, generation) => atomic(() => {
        if (this.receipt('remove', request, generation).found) return // receipt only; never re-delete
        if (this.generation !== generation) return fail('conflict')
        this.generation++ // retain tombstone even if already missing
        this.tokens = null
        this.pending = null
        this.exchange = null
        this.active = null
        this.changed()
        this.remember('remove', request, generation, null)
        this.acknowledged('remove')
      }),
    }
  }
}
