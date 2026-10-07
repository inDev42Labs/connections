import {
  connectionStorageKey,
  credentialOperationCommandKey,
  storeCommandKey,
  type AuthorizationAttemptLookup,
  type ConnectionKey,
  type ConnectionSnapshot,
  type CredentialOperationCommand,
  type StoreCommand,
  type StoreCommandResult,
} from '../../core/contracts/store.js'
import {
  decodeAttemptJson,
  decodeConnectionJson,
  decodeReceipt,
  isSchemaVersionOne,
} from '../internal/persisted-record-decoder.js'
import {
  projectConnection,
  transitionCredentialOperation,
  transitionStoreCommand,
  type StoreTransition,
  type StoredAuthorizationAttempt,
  type StoredCommand,
  type StoredConnection,
  type TransitionRecords,
} from '../internal/transition-kernel.js'
import type { SQLiteBinding, SynchronousSQLiteDatabase } from './database.js'

const connectionsTable = 'indev42_connections_sqlite_connections'
const attemptsTable = 'indev42_connections_sqlite_authorization_attempts'
const receiptsTable = 'indev42_connections_sqlite_receipts'

const schema = `
  CREATE TABLE IF NOT EXISTS ${connectionsTable} (
    storage_key TEXT PRIMARY KEY,
    schema_version INTEGER NOT NULL,
    record_json TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS ${attemptsTable} (
    namespace TEXT NOT NULL,
    state_digest TEXT NOT NULL,
    schema_version INTEGER NOT NULL,
    record_json TEXT NOT NULL,
    PRIMARY KEY (namespace, state_digest)
  );
  CREATE TABLE IF NOT EXISTS ${receiptsTable} (
    namespace TEXT NOT NULL,
    request_id TEXT NOT NULL,
    schema_version INTEGER NOT NULL,
    command_kind TEXT NOT NULL,
    input_digest TEXT NOT NULL,
    result_json TEXT NOT NULL,
    PRIMARY KEY (namespace, request_id)
  );
`

type SQLiteRow = Record<string, unknown>

function row(value: unknown): SQLiteRow | null {
  if (value === null || value === undefined) return null
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('Invalid SQLite row')
  }
  return value as SQLiteRow
}

function commandKey(command: StoredCommand): ConnectionKey {
  return command._tag === 'InitializeConnection' ||
    command._tag === 'CreateAuthorizationAttempt' ||
    command._tag === 'AdmitAuthorizationAttempt' ||
    command._tag === 'CloseAuthorizationAttempt' ||
    command._tag === 'CompleteAuthorizationAttempt'
    ? storeCommandKey(command)
    : credentialOperationCommandKey(command)
}

function clone<Value>(value: Value): Value {
  return structuredClone(value)
}

export class SQLitePersistence {
  readonly #database: SynchronousSQLiteDatabase
  #initialized = false

  constructor(database: SynchronousSQLiteDatabase) {
    this.#database = database
  }

  connection(key: ConnectionKey): StoredConnection | null {
    this.#initialize()
    const storageKey = connectionStorageKey(key)
    const stored = row(
      this.#get(
        `SELECT schema_version, record_json FROM ${connectionsTable} WHERE storage_key = ?`,
        storageKey,
      ),
    )
    if (stored === null) return null
    if (!isSchemaVersionOne(stored.schema_version)) {
      throw new TypeError('Unsupported SQLite record version')
    }
    const decoded = decodeConnectionJson(stored.record_json)
    if (connectionStorageKey(decoded.key) !== storageKey) {
      throw new TypeError('Mismatched SQLite connection identity')
    }
    return decoded
  }

  authorizationAttempt(
    lookup: Pick<AuthorizationAttemptLookup, 'namespace' | 'stateDigest'>,
  ): StoredAuthorizationAttempt | null {
    this.#initialize()
    const stored = row(
      this.#get(
        `SELECT schema_version, record_json FROM ${attemptsTable}
         WHERE namespace = ? AND state_digest = ?`,
        lookup.namespace,
        lookup.stateDigest,
      ),
    )
    if (stored === null) return null
    if (!isSchemaVersionOne(stored.schema_version)) {
      throw new TypeError('Unsupported SQLite record version')
    }
    const decoded = decodeAttemptJson(stored.record_json)
    if (
      decoded.attempt.key.namespace !== lookup.namespace ||
      decoded.attempt.stateDigest !== lookup.stateDigest
    ) {
      throw new TypeError('Mismatched SQLite attempt identity')
    }
    return decoded
  }

  execute(command: StoreCommand): StoreCommandResult {
    return this.#transaction(() => {
      const records = this.#records(command)
      return this.#commit(command, transitionStoreCommand(command, records), records.connection)
    })
  }

  executeCredentialOperation(command: CredentialOperationCommand): StoreCommandResult {
    return this.#transaction(() => {
      const records = this.#records(command)
      return this.#commit(
        command,
        transitionCredentialOperation(command, records),
        records.connection,
      )
    })
  }

  /** @internal Runs after transition writes and before their transaction commits. */
  protected recordCommandExecution(
    command: StoredCommand,
    result: StoreCommandResult,
    snapshot: ConnectionSnapshot | null,
  ): void {
    void command
    void result
    void snapshot
  }

  #initialize(): void {
    if (this.#initialized) return
    this.#database.exec(schema)
    this.#initialized = true
  }

  #get(sql: string, ...parameters: SQLiteBinding[]): unknown {
    return this.#database.prepare(sql).get(...parameters)
  }

  #run(sql: string, ...parameters: SQLiteBinding[]): void {
    this.#database.prepare(sql).run(...parameters)
  }

  #transaction<Value>(body: () => Value): Value {
    this.#initialize()
    this.#database.exec('BEGIN IMMEDIATE')
    let committed = false
    try {
      const value = body()
      this.#database.exec('COMMIT')
      committed = true
      return value
    } finally {
      if (!committed) {
        try {
          this.#database.exec('ROLLBACK')
        } catch {
          // Preserve the original database or decode failure.
        }
      }
    }
  }

  #records(command: StoredCommand): TransitionRecords {
    const key = commandKey(command)
    const connection = this.connection(key)
    let attempt: StoredAuthorizationAttempt | null = null
    switch (command._tag) {
      case 'CreateAuthorizationAttempt':
        attempt = this.authorizationAttempt({
          namespace: command.attempt.key.namespace,
          stateDigest: command.attempt.stateDigest,
        })
        break
      case 'AdmitAuthorizationAttempt':
      case 'CompleteAuthorizationAttempt':
        attempt = this.authorizationAttempt({
          namespace: command.admission.key.namespace,
          stateDigest: command.admission.stateDigest,
        })
        break
      case 'CloseAuthorizationAttempt':
        attempt = this.authorizationAttempt({
          namespace: command.key.namespace,
          stateDigest: command.stateDigest,
        })
        break
    }
    const selectedAttempt =
      connection?.authorizationAttemptStateDigest === null || connection === null
        ? null
        : this.authorizationAttempt({
            namespace: key.namespace,
            stateDigest: connection.authorizationAttemptStateDigest,
          })
    const storedReceipt = row(
      this.#get(
        `SELECT schema_version, command_kind, input_digest, result_json
         FROM ${receiptsTable} WHERE namespace = ? AND request_id = ?`,
        key.namespace,
        command.request.requestId,
      ),
    )
    if (storedReceipt !== null && !isSchemaVersionOne(storedReceipt.schema_version)) {
      throw new TypeError('Unsupported SQLite record version')
    }
    return {
      connection,
      attempt,
      selectedAttempt,
      receipt:
        storedReceipt === null
          ? null
          : decodeReceipt(
              storedReceipt.command_kind,
              storedReceipt.input_digest,
              storedReceipt.result_json,
            ),
    }
  }

  #commit(
    command: StoredCommand,
    transition: StoreTransition,
    previousConnection: StoredConnection | null,
  ): StoreCommandResult {
    const { writes } = transition
    if (writes.connection !== undefined) this.#writeConnection(writes.connection)
    for (const stored of writes.attempts ?? []) this.#writeAttempt(stored)
    if (writes.receipt !== undefined) {
      const key = commandKey(command)
      this.#run(
        `INSERT INTO ${receiptsTable}
           (namespace, request_id, schema_version, command_kind, input_digest, result_json)
         VALUES (?, ?, 1, ?, ?, ?)`,
        key.namespace,
        command.request.requestId,
        writes.receipt.commandKind,
        writes.receipt.inputDigest,
        JSON.stringify(writes.receipt.result),
      )
    }
    const result = clone(transition.result)
    this.recordCommandExecution(
      command,
      result,
      projectConnection(writes.connection ?? previousConnection),
    )
    return result
  }

  #writeConnection(stored: StoredConnection): void {
    this.#run(
      `INSERT INTO ${connectionsTable} (storage_key, schema_version, record_json)
       VALUES (?, 1, ?)
       ON CONFLICT(storage_key) DO UPDATE SET
         schema_version = excluded.schema_version,
         record_json = excluded.record_json`,
      connectionStorageKey(stored.key),
      JSON.stringify(stored),
    )
  }

  #writeAttempt(stored: StoredAuthorizationAttempt): void {
    this.#run(
      `INSERT INTO ${attemptsTable} (namespace, state_digest, schema_version, record_json)
       VALUES (?, ?, 1, ?)
       ON CONFLICT(namespace, state_digest) DO UPDATE SET
         schema_version = excluded.schema_version,
         record_json = excluded.record_json`,
      stored.attempt.key.namespace,
      stored.attempt.stateDigest,
      JSON.stringify(stored),
    )
  }
}
