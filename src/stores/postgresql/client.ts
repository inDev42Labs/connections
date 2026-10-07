export type PostgreSQLParameter = string | number | boolean | null

export interface PostgreSQLRow {
  readonly [column: string]: unknown
}

export interface PostgreSQLQueryResult {
  readonly rows: readonly PostgreSQLRow[]
}

/**
 * The checked-out client surface used by the PostgreSQL store.
 *
 * Both node-postgres and the WebSocket Pool from @neondatabase/serverless
 * satisfy this interface. The store releases every client it acquires.
 */
export interface PostgreSQLClient {
  query(sql: string, parameters?: PostgreSQLParameter[]): PromiseLike<PostgreSQLQueryResult>
  release(destroy?: boolean): void
}

/** A consumer-owned node-postgres-compatible pool. */
export interface PostgreSQLPool {
  connect(): PromiseLike<PostgreSQLClient>
}
