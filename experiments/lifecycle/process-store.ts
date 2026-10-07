// Disposable test adapter ONLY. Trusted, locally generated JSON; no production migration/validation.
import { DatabaseSync } from 'node:sqlite'
import { Effect, Result } from 'effect'
import { atomic, type Fault, type Store, type Provider } from './model'
import { FakeDatabase } from './store'
import { FakeProvider } from './fakes'

class Cell<S> {
  private readonly db: DatabaseSync
  constructor(path: string, initial?: S) {
    this.db = new DatabaseSync(path)
    try {
      this.db.exec('PRAGMA busy_timeout=5000; PRAGMA synchronous=FULL; CREATE TABLE IF NOT EXISTS state (id INTEGER PRIMARY KEY CHECK(id=1), json TEXT NOT NULL)')
      if (initial !== undefined) this.db.prepare('INSERT INTO state VALUES (1, ?)').run(JSON.stringify(initial))
    } catch (error) { this.db.close(); throw error }
  }
  read(): S {
    const row = this.db.prepare('SELECT json FROM state WHERE id=1').get() as { json: string } | undefined
    if (!row) throw new Error('Missing owned fixture state')
    return JSON.parse(row.json) as S
  }
  transaction<A>(body: (state: S) => { state: S; value: A }): A {
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const result = body(this.read())
      this.db.prepare('UPDATE state SET json=? WHERE id=1').run(JSON.stringify(result.state))
      this.db.exec('COMMIT')
      return result.value
    } catch (error) { this.db.exec('ROLLBACK'); throw error }
  }
  close() { this.db.close() }
}

export class ProcessStore {
  private readonly credentials: Cell<ReturnType<FakeDatabase['exportState']>>
  private readonly issuer: Cell<ReturnType<FakeProvider['exportState']>>
  constructor(directory: string, initial?: { db: FakeDatabase; provider: FakeProvider }) {
    this.credentials = new Cell(`${directory}/credentials.sqlite`, initial?.db.exportState())
    try { this.issuer = new Cell(`${directory}/provider.sqlite`, initial?.provider.exportState()) }
    catch (error) { this.credentials.close(); throw error }
  }
  database<A>(body: (db: FakeDatabase) => A): A {
    return this.credentials.transaction((state) => {
      const db = FakeDatabase.restoreState(state)
      const value = body(db)
      return { state: db.exportState(), value }
    })
  }
  providerState() { return this.issuer.read() }
  private query<A>(body: (store: Store['Service']) => Effect.Effect<A, Fault>): Effect.Effect<A, Fault> {
    return Effect.suspend(() => body(FakeDatabase.restoreState(this.credentials.read()).client()))
  }
  private call<A>(body: (store: Store['Service']) => Effect.Effect<A, Fault>): Effect.Effect<A, Fault> {
    // Result captures modeled failures so ack-lost commits. Defects/SQLite errors roll back
    // this local transaction and remain defects, never disguised as provider uncertainty.
    return Effect.flatMap(atomic(() => this.database((db) => Effect.runSync(Effect.result(body(db.client()))))),
      (result) => Result.isSuccess(result) ? Effect.succeed(result.success) : Effect.fail(result.failure))
  }
  client(): Store['Service'] {
    return {
      read: () => this.query((s) => s.read()), inspect: () => this.query((s) => s.inspect()),
      claim: (...args) => this.call((s) => s.claim(...args)), renew: (...args) => this.call((s) => s.renew(...args)),
      checkpoint: (...args) => this.call((s) => s.checkpoint(...args)), complete: (...args) => this.call((s) => s.complete(...args)),
      start: (...args) => this.call((s) => s.start(...args)), consume: (...args) => this.call((s) => s.consume(...args)),
      authorize: (...args) => this.call((s) => s.authorize(...args)), remove: (...args) => this.call((s) => s.remove(...args)),
    }
  }
  provider(afterCommit: () => Effect.Effect<void, Fault> = () => Effect.void): Provider['Service'] {
    const invoke = <A>(body: (service: Provider['Service']) => Effect.Effect<A, Fault>) => Effect.gen({ self: this }, function* () {
      const result = yield* atomic(() => {
        // No credential transaction is open while the fake issuer processes/commits.
        const now = this.credentials.read().now
        return this.issuer.transaction((state) => {
          const provider = FakeProvider.restoreState(state, () => now)
          const value = Effect.runSync(Effect.result(body(provider.service())))
          return { state: provider.exportState(), value }
        })
      })
      yield* afterCommit()
      return yield* Result.isSuccess(result) ? Effect.succeed(result.success) : Effect.fail(result.failure)
    })
    const adapter = this
    return { get policy() { return adapter.providerState().policy },
      refresh: (tokens) => invoke((p) => p.refresh(tokens)), exchange: () => invoke((p) => p.exchange()) }
  }
  close() { this.credentials.close(); this.issuer.close() }
}
