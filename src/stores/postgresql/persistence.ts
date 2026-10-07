import {
  connectionStorageKey,
  credentialOperationCommandKey,
  storeCommandKey,
  type AuthorizationAttemptLookup,
  type ConnectionKey,
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
  transitionCredentialOperation,
  transitionStoreCommand,
  type StoreTransition,
  type StoredAuthorizationAttempt,
  type StoredCommand,
  type StoredConnection,
  type TransitionRecords,
} from '../internal/transition-kernel.js'
import type {
  PostgreSQLClient,
  PostgreSQLPool,
  PostgreSQLQueryResult,
  PostgreSQLRow,
} from './client.js'

const connectionsTableName = 'indev42_connections_postgresql_connections'
const attemptsTableName = 'indev42_connections_postgresql_authorization_attempts'
const receiptsTableName = 'indev42_connections_postgresql_receipts'
const schemaIdentifier = /^[A-Za-z_][A-Za-z0-9_$]{0,62}$/
const advisoryLockQuery = 'SELECT pg_advisory_xact_lock($1::bigint)'

function quoteSchema(schema: string | undefined): string {
  const selected = schema ?? 'public'
  if (!schemaIdentifier.test(selected)) {
    throw new TypeError('Invalid PostgreSQL schema identifier')
  }
  return `"${selected.replaceAll('"', '""')}"`
}

function table(schema: string, name: string): string {
  return `${schema}."${name}"`
}

function queryRows(result: PostgreSQLQueryResult): readonly PostgreSQLRow[] {
  if (typeof result !== 'object' || result === null || !Array.isArray(result.rows)) {
    throw new TypeError('Invalid PostgreSQL query result')
  }
  return result.rows
}

function row(value: unknown): PostgreSQLRow | null {
  if (value === undefined) return null
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError('Invalid PostgreSQL row')
  }
  return value as PostgreSQLRow
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

function commandAttemptIdentity(
  command: StoredCommand,
): { readonly namespace: string; readonly stateDigest: string } | null {
  switch (command._tag) {
    case 'CreateAuthorizationAttempt':
      return {
        namespace: command.attempt.key.namespace,
        stateDigest: command.attempt.stateDigest,
      }
    case 'AdmitAuthorizationAttempt':
    case 'CompleteAuthorizationAttempt':
      return {
        namespace: command.admission.key.namespace,
        stateDigest: command.admission.stateDigest,
      }
    case 'CloseAuthorizationAttempt':
      return { namespace: command.key.namespace, stateDigest: command.stateDigest }
    default:
      return null
  }
}

function lockIdentities(command: StoredCommand, scope: string): readonly string[] {
  const key = commandKey(command)
  const identities = [
    `0:request:${JSON.stringify([scope, key.namespace, command.request.requestId])}`,
    `1:connection:${JSON.stringify([scope, key.namespace, key.providerId, key.connectionId])}`,
  ]
  const attempt = commandAttemptIdentity(command)
  if (attempt !== null) {
    identities.push(`2:attempt:${JSON.stringify([scope, attempt.namespace, attempt.stateDigest])}`)
  }
  return identities.sort()
}

function advisoryLockKey(identity: string): string {
  let hash = 14_695_981_039_346_656_037n
  for (const byte of new TextEncoder().encode(identity)) {
    hash ^= BigInt(byte)
    hash = BigInt.asUintN(64, hash * 1_099_511_628_211n)
  }
  return BigInt.asIntN(64, hash).toString()
}

function clone<Value>(value: Value): Value {
  return structuredClone(value)
}

export class PostgreSQLPersistence {
  readonly #pool: PostgreSQLPool
  readonly #schema: string
  readonly #lockScope: string
  readonly #connectionsTable: string
  readonly #attemptsTable: string
  readonly #receiptsTable: string
  #initialized = false
  #initializing: Promise<void> | null = null

  constructor(pool: PostgreSQLPool, schema?: string) {
    this.#pool = pool
    this.#schema = quoteSchema(schema)
    this.#lockScope = schema ?? 'public'
    this.#connectionsTable = table(this.#schema, connectionsTableName)
    this.#attemptsTable = table(this.#schema, attemptsTableName)
    this.#receiptsTable = table(this.#schema, receiptsTableName)
  }

  connection(key: ConnectionKey): Promise<StoredConnection | null> {
    return this.#withClient(async (client) => {
      await this.#initialize(client)
      return this.#readConnection(client, key, false)
    })
  }

  authorizationAttempt(
    lookup: Pick<AuthorizationAttemptLookup, 'namespace' | 'stateDigest'>,
  ): Promise<StoredAuthorizationAttempt | null> {
    return this.#withClient(async (client) => {
      await this.#initialize(client)
      return this.#readAuthorizationAttempt(client, lookup, false)
    })
  }

  authorizationAttemptWithConnection(
    lookup: Pick<AuthorizationAttemptLookup, 'namespace' | 'stateDigest'>,
  ): Promise<{
    readonly attempt: StoredAuthorizationAttempt | null
    readonly connection: StoredConnection | null
  }> {
    return this.#withClient(async (client) => {
      await this.#initialize(client)
      const attempt = await this.#readAuthorizationAttempt(client, lookup, false)
      const connection =
        attempt === null ? null : await this.#readConnection(client, attempt.attempt.key, false)
      return { attempt, connection }
    })
  }

  execute(command: StoreCommand): Promise<StoreCommandResult> {
    return this.#execute(command, (records) => transitionStoreCommand(command, records))
  }

  executeCredentialOperation(command: CredentialOperationCommand): Promise<StoreCommandResult> {
    return this.#execute(command, (records) => transitionCredentialOperation(command, records))
  }

  async #execute(
    command: StoredCommand,
    transition: (records: TransitionRecords) => StoreTransition,
  ): Promise<StoreCommandResult> {
    return this.#withClient(async (client, discard) => {
      await this.#initialize(client, discard)
      return this.#transaction(
        client,
        lockIdentities(command, this.#lockScope),
        async () => this.#commit(client, command, transition(await this.#records(client, command))),
        discard,
      )
    })
  }

  async #withClient<Value>(
    use: (client: PostgreSQLClient, discard: () => void) => Promise<Value>,
  ): Promise<Value> {
    const client = await this.#pool.connect()
    let destroy = false
    try {
      return await use(client, () => (destroy = true))
    } finally {
      client.release(destroy)
    }
  }

  async #initialize(
    client: PostgreSQLClient,
    discard: () => void = () => undefined,
  ): Promise<void> {
    if (this.#initialized) return
    if (this.#initializing !== null) return this.#initializing

    const initializing = this.#transaction(
      client,
      [`initialize:${this.#lockScope}`],
      async () => {
        await client.query(
          `CREATE TABLE IF NOT EXISTS ${this.#connectionsTable} (
             storage_key TEXT PRIMARY KEY,
             schema_version INTEGER NOT NULL,
             record_json TEXT NOT NULL
           )`,
        )
        await client.query(
          `CREATE TABLE IF NOT EXISTS ${this.#attemptsTable} (
             namespace TEXT NOT NULL,
             state_digest TEXT NOT NULL,
             schema_version INTEGER NOT NULL,
             record_json TEXT NOT NULL,
             PRIMARY KEY (namespace, state_digest)
           )`,
        )
        await client.query(
          `CREATE TABLE IF NOT EXISTS ${this.#receiptsTable} (
             namespace TEXT NOT NULL,
             request_id TEXT NOT NULL,
             schema_version INTEGER NOT NULL,
             command_kind TEXT NOT NULL,
             input_digest TEXT NOT NULL,
             result_json TEXT NOT NULL,
             PRIMARY KEY (namespace, request_id)
           )`,
        )
      },
      discard,
    )
    this.#initializing = initializing
    try {
      await initializing
      this.#initialized = true
    } finally {
      if (this.#initializing === initializing) this.#initializing = null
    }
  }

  async #transaction<Value>(
    client: PostgreSQLClient,
    identities: readonly string[],
    body: () => Promise<Value>,
    discard: () => void,
  ): Promise<Value> {
    let began = false
    let committed = false
    try {
      await client.query('BEGIN')
      began = true
      for (const identity of identities) {
        await client.query(advisoryLockQuery, [advisoryLockKey(identity)])
      }
      const value = await body()
      await client.query('COMMIT')
      committed = true
      return value
    } finally {
      if (began && !committed) {
        try {
          await client.query('ROLLBACK')
        } catch {
          discard()
        }
      }
    }
  }

  async #readConnection(
    client: PostgreSQLClient,
    key: ConnectionKey,
    forUpdate: boolean,
  ): Promise<StoredConnection | null> {
    const storageKey = connectionStorageKey(key)
    const result = await client.query(
      `SELECT schema_version, record_json FROM ${this.#connectionsTable}
       WHERE storage_key = $1${forUpdate ? ' FOR UPDATE' : ''}`,
      [storageKey],
    )
    const stored = row(queryRows(result)[0])
    if (stored === null) return null
    if (!isSchemaVersionOne(stored.schema_version)) {
      throw new TypeError('Unsupported PostgreSQL record version')
    }
    const decoded = decodeConnectionJson(stored.record_json)
    if (connectionStorageKey(decoded.key) !== storageKey) {
      throw new TypeError('Mismatched PostgreSQL connection identity')
    }
    return decoded
  }

  async #readAuthorizationAttempt(
    client: PostgreSQLClient,
    lookup: Pick<AuthorizationAttemptLookup, 'namespace' | 'stateDigest'>,
    forUpdate: boolean,
  ): Promise<StoredAuthorizationAttempt | null> {
    const result = await client.query(
      `SELECT schema_version, record_json FROM ${this.#attemptsTable}
       WHERE namespace = $1 AND state_digest = $2${forUpdate ? ' FOR UPDATE' : ''}`,
      [lookup.namespace, lookup.stateDigest],
    )
    const stored = row(queryRows(result)[0])
    if (stored === null) return null
    if (!isSchemaVersionOne(stored.schema_version)) {
      throw new TypeError('Unsupported PostgreSQL record version')
    }
    const decoded = decodeAttemptJson(stored.record_json)
    if (
      decoded.attempt.key.namespace !== lookup.namespace ||
      decoded.attempt.stateDigest !== lookup.stateDigest
    ) {
      throw new TypeError('Mismatched PostgreSQL attempt identity')
    }
    return decoded
  }

  async #records(client: PostgreSQLClient, command: StoredCommand): Promise<TransitionRecords> {
    const key = commandKey(command)
    const connection = await this.#readConnection(client, key, true)
    let attempt: StoredAuthorizationAttempt | null = null
    const attemptIdentity = commandAttemptIdentity(command)
    if (attemptIdentity !== null) {
      attempt = await this.#readAuthorizationAttempt(client, attemptIdentity, true)
    }
    const selectedAttempt =
      connection?.authorizationAttemptStateDigest === null || connection === null
        ? null
        : await this.#readAuthorizationAttempt(
            client,
            {
              namespace: key.namespace,
              stateDigest: connection.authorizationAttemptStateDigest,
            },
            true,
          )
    const receiptResult = await client.query(
      `SELECT schema_version, command_kind, input_digest, result_json
       FROM ${this.#receiptsTable} WHERE namespace = $1 AND request_id = $2 FOR UPDATE`,
      [key.namespace, command.request.requestId],
    )
    const storedReceipt = row(queryRows(receiptResult)[0])
    if (storedReceipt !== null && !isSchemaVersionOne(storedReceipt.schema_version)) {
      throw new TypeError('Unsupported PostgreSQL record version')
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

  async #commit(
    client: PostgreSQLClient,
    command: StoredCommand,
    transition: StoreTransition,
  ): Promise<StoreCommandResult> {
    const { writes } = transition
    if (writes.connection !== undefined) await this.#writeConnection(client, writes.connection)
    for (const stored of writes.attempts ?? []) await this.#writeAttempt(client, stored)
    if (writes.receipt !== undefined) {
      const key = commandKey(command)
      await client.query(
        `INSERT INTO ${this.#receiptsTable}
           (namespace, request_id, schema_version, command_kind, input_digest, result_json)
         VALUES ($1, $2, 1, $3, $4, $5)`,
        [
          key.namespace,
          command.request.requestId,
          writes.receipt.commandKind,
          writes.receipt.inputDigest,
          JSON.stringify(writes.receipt.result),
        ],
      )
    }
    return clone(transition.result)
  }

  async #writeConnection(client: PostgreSQLClient, stored: StoredConnection): Promise<void> {
    await client.query(
      `INSERT INTO ${this.#connectionsTable} (storage_key, schema_version, record_json)
       VALUES ($1, 1, $2)
       ON CONFLICT (storage_key) DO UPDATE SET
         schema_version = EXCLUDED.schema_version,
         record_json = EXCLUDED.record_json`,
      [connectionStorageKey(stored.key), JSON.stringify(stored)],
    )
  }

  async #writeAttempt(client: PostgreSQLClient, stored: StoredAuthorizationAttempt): Promise<void> {
    await client.query(
      `INSERT INTO ${this.#attemptsTable} (namespace, state_digest, schema_version, record_json)
       VALUES ($1, $2, 1, $3)
       ON CONFLICT (namespace, state_digest) DO UPDATE SET
         schema_version = EXCLUDED.schema_version,
         record_json = EXCLUDED.record_json`,
      [stored.attempt.key.namespace, stored.attempt.stateDigest, JSON.stringify(stored)],
    )
  }
}
