export type SQLiteBinding = string | number | bigint | Uint8Array | null

export interface SynchronousSQLiteStatement {
  get(...parameters: SQLiteBinding[]): unknown
  run(...parameters: SQLiteBinding[]): unknown
}

/**
 * The synchronous SQLite surface used by the built-in store.
 *
 * Both `node:sqlite`'s `DatabaseSync` and `bun:sqlite`'s `Database` satisfy this
 * interface. The store never takes ownership of the supplied database.
 */
export interface SynchronousSQLiteDatabase {
  exec(sql: string): unknown
  prepare(sql: string): SynchronousSQLiteStatement
}
