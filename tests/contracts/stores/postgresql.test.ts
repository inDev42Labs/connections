import { PGlite } from '@electric-sql/pglite'
import { PGLiteSocketServer } from '@electric-sql/pglite-socket'
import { Effect, Redacted } from 'effect'
import pg from 'pg'
import { afterAll, beforeAll, expect, test } from 'vitest'
import type { EncryptionContext } from '../../../src/core/contracts/encryptor.js'
import { AesGcm, EncryptionFailure } from '../../../src/encryptors/aes-gcm/index.js'
import {
  connectionStorageKey,
  digestStoreInput,
  type AuthorizationAdmission,
  type AuthorizationAttempt,
  type ConnectionKey,
  type CredentialOperationCommandInput,
  type StoreCommandInput,
} from '../../../src/stores/index.js'
import {
  PostgreSQL,
  PostgreSQLStorageFailure,
  type PostgreSQLClient,
  type PostgreSQLParameter,
  type PostgreSQLPool,
  type PostgreSQLQueryResult,
} from '../../../src/stores/postgresql/index.js'
import { credentialOperationStoreConformance, storeConformance } from './conformance.js'

const { Pool } = pg
const connectionsTable = 'indev42_connections_postgresql_connections'
const attemptsTable = 'indev42_connections_postgresql_authorization_attempts'
const receiptsTable = 'indev42_connections_postgresql_receipts'
const encryptor = AesGcm.encryptor({
  key: Effect.succeed(Redacted.make('KioqKioqKioqKioqKioqKioqKioqKioqKioqKioqKio=')),
  keyId: 'postgresql-conformance',
})

let database: PGlite
let server: PGLiteSocketServer
let pool: InstanceType<typeof Pool>

beforeAll(async () => {
  database = await PGlite.create()
  server = new PGLiteSocketServer({
    db: database,
    host: '127.0.0.1',
    port: 0,
    maxConnections: 20,
  })
  await server.start()
  const [host, port] = server.getServerConn().split(':')
  pool = new Pool({
    host,
    port: Number(port),
    user: 'postgres',
    database: 'postgres',
    ssl: false,
    max: 20,
  })
}, 30_000)

// Closing the consumer-owned pool is deliberately test-fixture responsibility.
afterAll(async () => {
  await pool?.end()
  await server?.stop()
  await database?.close()
})

function qualified(schema: string, table: string): string {
  return `"${schema}"."${table}"`
}

function makeTarget() {
  return {
    store: PostgreSQL.store({ pool, encryptor }),
    run: <Value, Error>(effect: Effect.Effect<Value, Error>) => Effect.runPromise(effect),
    pruneReceipts: async () => {
      await pool.query(`DELETE FROM ${qualified('public', receiptsTable)}`)
    },
  }
}

storeConformance('PostgreSQL store', makeTarget)
credentialOperationStoreConformance('PostgreSQL store', makeTarget)

async function withRequest<Command extends StoreCommandInput>(
  command: Command,
  requestId: string,
): Promise<
  Command & { readonly request: { readonly requestId: string; readonly inputDigest: string } }
> {
  return {
    ...command,
    request: { requestId, inputDigest: await digestStoreInput(command) },
  }
}

async function withCredentialOperationRequest<Command extends CredentialOperationCommandInput>(
  command: Command,
  requestId: string,
): Promise<
  Command & { readonly request: { readonly requestId: string; readonly inputDigest: string } }
> {
  return {
    ...command,
    request: { requestId, inputDigest: await digestStoreInput(command) },
  }
}

test('PostgreSQL store: direct encryption key protects and unprotects credentials', async () => {
  const store = PostgreSQL.store({
    pool,
    encryptionKey: 'KioqKioqKioqKioqKioqKioqKioqKioqKioqKioqKio=',
  })
  const context = {
    namespace: 'direct-key',
    providerId: 'salesforce',
    connectionId: 'connection',
    generation: 0,
    purpose: 'credentials' as const,
  }
  const plaintext = 'direct-key-postgresql-credential'
  const envelope = await Effect.runPromise(store.protect(Redacted.make(plaintext), context))

  expect(envelope.algorithm).toBe('AES-256-GCM')
  expect(JSON.stringify(envelope)).not.toContain(plaintext)
  await expect(
    Effect.runPromise(store.unprotect(envelope, context)).then(Redacted.value),
  ).resolves.toBe(plaintext)
})

test('PostgreSQL store: invalid direct encryption key fails safely', async () => {
  const invalidKey = 'not-a-valid-aes-key'
  const store = PostgreSQL.store({ pool, encryptionKey: invalidKey })
  const failure = await Effect.runPromise(
    Effect.flip(
      store.protect(Redacted.make('credential'), {
        namespace: 'direct-key',
        providerId: 'salesforce',
        connectionId: 'connection',
        generation: 0,
        purpose: 'credentials',
      }),
    ),
  )

  expect(failure).toBeInstanceOf(EncryptionFailure)
  expect(failure).toMatchObject({ _tag: 'EncryptionFailure', reason: 'InvalidKey' })
  expect(JSON.stringify(failure)).not.toContain(invalidKey)
})

test('PostgreSQL store: a stable direct encryption key decrypts credentials after store recreation', async () => {
  const encryptionKey = 'KioqKioqKioqKioqKioqKioqKioqKioqKioqKioqKio='
  const key = {
    namespace: 'direct-key-reopen',
    providerId: 'salesforce',
    connectionId: 'connection',
  }
  const context = { ...key, generation: 0, purpose: 'credentials' as const }
  const plaintext = 'persisted-direct-key-credential'
  const firstStore = PostgreSQL.store({ pool, encryptionKey })
  const credentialEnvelope = await Effect.runPromise(
    firstStore.protect(Redacted.make(plaintext), context),
  )
  const saved = await Effect.runPromise(
    firstStore.executeCredentialOperation(
      await withCredentialOperationRequest(
        {
          _tag: 'SaveCredential' as const,
          key,
          expectedGeneration: 0,
          expectedRevision: 0,
          intent: 'enroll' as const,
          credentialEnvelope,
          credentialExpiresAt: null,
          credentialAcquiredAt: 1_000,
        },
        'direct-key-save',
      ),
    ),
  )
  expect(saved._tag).toBe('CredentialSaved')
  if (saved._tag !== 'CredentialSaved') throw new Error('Expected direct-key credential save')

  const reopenedStore = PostgreSQL.store({ pool, encryptionKey })
  const connection = await Effect.runPromise(reopenedStore.readConnection(key))
  if (connection === null || connection.credentialEnvelope === null) {
    throw new Error('Expected persisted direct-key credential')
  }
  const decrypted = await Effect.runPromise(
    reopenedStore.unprotect(connection.credentialEnvelope, context),
  )

  expect(Redacted.value(decrypted)).toBe(plaintext)
})

function authorizationAttempt(key: ConnectionKey, stateDigest: string): AuthorizationAttempt {
  return {
    schemaVersion: 1,
    stateDigest,
    key,
    generation: 0,
    intent: 'enroll',
    bindingDigest: `binding:${stateDigest}`,
    pkceVerifierEnvelope: {
      version: 1,
      algorithm: 'AES-256-GCM',
      keyId: 'test',
      iv: 'AAAAAAAAAAAAAAAA',
      ciphertext: 'AAAAAAAAAAAAAAAAAAAAAA==',
    },
    createdAt: 1_000,
    expiresAt: 10_000,
  }
}

function admissionCommand(admission: AuthorizationAdmission, owner: string) {
  return {
    _tag: 'AdmitAuthorizationAttempt' as const,
    admission,
    ownershipFence: `fence:${owner}`,
    leaseExpiresAt: 3_000,
    operation: {
      operationId: `operation:${owner}`,
      kind: 'authorization-exchange' as const,
      startedAt: admission.admittedAt,
      recoveryDeadline: 10_000,
      transferLimit: 3,
    },
  }
}

interface QueryTrace {
  readonly client: number
  readonly sql: string
  readonly parameters: PostgreSQLParameter[] | undefined
}

function trackedPool(
  intercept?: (sql: string, parameters: PostgreSQLParameter[] | undefined) => void | Promise<void>,
): {
  readonly pool: PostgreSQLPool
  readonly traces: QueryTrace[]
  readonly metrics: {
    acquired: number
    released: number
    active: number
    maxActive: number
  }
} {
  const traces: QueryTrace[] = []
  const metrics = { acquired: 0, released: 0, active: 0, maxActive: 0 }
  return {
    pool: {
      connect: async () => {
        const client = await pool.connect()
        const id = ++metrics.acquired
        metrics.active++
        metrics.maxActive = Math.max(metrics.maxActive, metrics.active)
        let released = false
        return {
          query: async (
            sql: string,
            parameters?: PostgreSQLParameter[],
          ): Promise<PostgreSQLQueryResult> => {
            traces.push({ client: id, sql, parameters })
            await intercept?.(sql, parameters)
            return client.query(sql, parameters)
          },
          release: (destroy?: boolean) => {
            if (released) throw new Error('Test client released twice')
            released = true
            metrics.released++
            metrics.active--
            client.release(destroy)
          },
        } satisfies PostgreSQLClient
      },
    },
    traces,
    metrics,
  }
}

async function rawConnectionRecord(key: ConnectionKey, schema = 'public') {
  return pool.query(
    `SELECT schema_version, record_json FROM ${qualified(schema, connectionsTable)}
     WHERE storage_key = $1`,
    [connectionStorageKey(key)],
  )
}

test('PostgreSQL store: initializes lazily, idempotently, and leaves its pool open', async () => {
  const tracked = trackedPool()
  const first = PostgreSQL.store({ pool: tracked.pool, encryptor })
  const second = PostgreSQL.store({ pool: tracked.pool, encryptor })
  const firstKey = {
    namespace: 'postgresql-lazy-first',
    providerId: 'salesforce',
    connectionId: 'connection',
  }
  const secondKey = { ...firstKey, namespace: 'postgresql-lazy-second' }
  const firstRead = first.readConnection(firstKey)
  const secondRead = second.readConnection(secondKey)

  expect(tracked.metrics.acquired).toBe(0)
  await Promise.all([Effect.runPromise(firstRead), Effect.runPromise(secondRead)])
  expect(tracked.metrics.acquired).toBe(2)
  expect(tracked.metrics.released).toBe(2)
  expect(tracked.metrics.active).toBe(0)
  expect(
    tracked.traces.filter(({ sql }) => sql.includes('CREATE TABLE IF NOT EXISTS')),
  ).toHaveLength(6)
  await expect(pool.query('SELECT 1 AS available')).resolves.toMatchObject({
    rows: [{ available: 1 }],
  })
})

test('PostgreSQL store: persists versioned records across store recreation', async () => {
  const key = {
    namespace: 'postgresql-persistence',
    providerId: 'salesforce',
    connectionId: 'connection',
  }
  const attempt = authorizationAttempt(key, 'state:postgresql-persistence')
  const command = await withRequest(
    { _tag: 'CreateAuthorizationAttempt' as const, attempt },
    'postgresql-persistence:create',
  )
  const created = await Effect.runPromise(PostgreSQL.store({ pool, encryptor }).execute(command))
  const recreated = PostgreSQL.store({ pool, encryptor })

  await expect(Effect.runPromise(recreated.readConnection(key))).resolves.toMatchObject({
    schemaVersion: 1,
    key,
    generation: 0,
    revision: 1,
    authorization: { _tag: 'NotAuthorized' },
  })
  await expect(
    Effect.runPromise(
      recreated.readAuthorizationAttempt({
        namespace: key.namespace,
        stateDigest: attempt.stateDigest,
        bindingDigest: attempt.bindingDigest,
        now: 1_500,
      }),
    ),
  ).resolves.toEqual(attempt)
  await expect(Effect.runPromise(recreated.execute(command))).resolves.toEqual(created)

  for (const table of [connectionsTable, attemptsTable, receiptsTable]) {
    const result = await pool.query(
      `SELECT schema_version FROM ${qualified('public', table)} LIMIT 1`,
    )
    expect(result.rows[0]).toEqual({ schema_version: 1 })
  }
})

test('PostgreSQL store: admits one winner while independent pooled clients are checked out', async () => {
  const tracked = trackedPool()
  const store = PostgreSQL.store({ pool: tracked.pool, encryptor })
  const key = {
    namespace: 'postgresql-independent-clients',
    providerId: 'salesforce',
    connectionId: 'connection',
  }
  const attempt = authorizationAttempt(key, 'state:postgresql-independent-clients')
  await Effect.runPromise(
    store.execute(
      await withRequest(
        { _tag: 'CreateAuthorizationAttempt' as const, attempt },
        'postgresql-independent-clients:create',
      ),
    ),
  )
  tracked.metrics.acquired = 0
  tracked.metrics.released = 0
  tracked.metrics.active = 0
  tracked.metrics.maxActive = 0
  tracked.traces.length = 0

  const admission = {
    stateDigest: attempt.stateDigest,
    key,
    intent: 'enroll' as const,
    generation: 0,
    admissionId: 'postgresql-independent-clients:admission',
    admittedAt: 1_500,
    admissionExpiresAt: 9_000,
  }
  const first = await withRequest(
    admissionCommand(admission, 'first'),
    'postgresql-independent-clients:admit:first',
  )
  const second = await withRequest(
    admissionCommand(admission, 'second'),
    'postgresql-independent-clients:admit:second',
  )
  const results = await Promise.all([
    Effect.runPromise(store.execute(first)),
    Effect.runPromise(store.execute(second)),
  ])

  expect(results.filter((result) => result._tag === 'AuthorizationAttemptAdmitted')).toHaveLength(1)
  expect(results.filter((result) => result._tag === 'StoreConflict')).toEqual([
    { _tag: 'StoreConflict', reason: 'ConditionChanged' },
  ])
  expect(tracked.metrics.maxActive).toBe(2)
  expect(tracked.metrics.released).toBe(tracked.metrics.acquired)
  expect(tracked.metrics.active).toBe(0)
  expect(tracked.traces.filter(({ sql }) => sql.includes('pg_advisory_xact_lock'))).toHaveLength(6)
})

test('PostgreSQL store: selects a safely quoted existing schema', async () => {
  const schema = 'select'
  await pool.query(`CREATE SCHEMA "${schema}"`)
  const store = PostgreSQL.store({ pool, encryptor, schema })
  const key = {
    namespace: 'postgresql-selected-schema',
    providerId: 'salesforce',
    connectionId: 'connection',
  }
  await Effect.runPromise(
    store.execute(
      await withRequest(
        { _tag: 'InitializeConnection' as const, key },
        'postgresql-selected-schema:initialize',
      ),
    ),
  )

  const selected = await pool.query(
    `SELECT table_name FROM information_schema.tables
     WHERE table_schema = $1 AND table_name = ANY($2::text[])
     ORDER BY table_name`,
    [schema, [attemptsTable, connectionsTable, receiptsTable]],
  )
  expect(selected.rows.map(({ table_name }) => table_name)).toEqual(
    [attemptsTable, connectionsTable, receiptsTable].sort(),
  )
  expect((await rawConnectionRecord(key, schema)).rows).toHaveLength(1)

  expect(() =>
    PostgreSQL.store({
      pool,
      encryptor,
      schema: 'unsafe"; DROP SCHEMA public; --',
    }),
  ).toThrowError('Invalid PostgreSQL schema identifier')
})

test('PostgreSQL store: delegates encryption lazily without acquiring a client', async () => {
  const tracked = trackedPool()
  const calls: Array<{
    readonly operation: 'encrypt' | 'decrypt'
    readonly context: EncryptionContext
  }> = []
  let protectedPlaintext: string | undefined
  let unprotectedEnvelope: unknown
  const envelope = {
    version: 1,
    algorithm: 'AES-256-GCM',
    keyId: 'delegated',
    iv: 'iv',
    ciphertext: 'ciphertext',
  } as const
  const delegatedEncryptor = {
    encrypt: (plaintext: Redacted.Redacted<string>, context: EncryptionContext) =>
      Effect.sync(() => {
        protectedPlaintext = Redacted.value(plaintext)
        calls.push({ operation: 'encrypt', context })
        return envelope
      }),
    decrypt: (storedEnvelope: unknown, context: EncryptionContext) =>
      Effect.sync(() => {
        unprotectedEnvelope = storedEnvelope
        calls.push({ operation: 'decrypt', context })
        return Redacted.make('decrypted')
      }),
  }
  const store = PostgreSQL.store({ pool: tracked.pool, encryptor: delegatedEncryptor })
  const context = {
    namespace: 'postgresql-delegation',
    providerId: 'salesforce',
    connectionId: 'connection',
    generation: 0,
    purpose: 'credentials' as const,
  }
  const protectedEffect = store.protect(Redacted.make('plaintext'), context)
  const unprotectedEffect = store.unprotect(envelope, context)

  expect(calls).toEqual([])
  expect(tracked.metrics.acquired).toBe(0)
  await expect(Effect.runPromise(protectedEffect)).resolves.toEqual(envelope)
  await expect(Effect.runPromise(unprotectedEffect)).resolves.toSatisfy(
    (value) => Redacted.value(value) === 'decrypted',
  )
  expect(protectedPlaintext).toBe('plaintext')
  expect(unprotectedEnvelope).toBe(envelope)
  expect(calls).toEqual([
    { operation: 'encrypt', context },
    { operation: 'decrypt', context },
  ])
  expect(tracked.metrics.acquired).toBe(0)
})

test('PostgreSQL store: releases a client after every storage operation', async () => {
  const tracked = trackedPool()
  const store = PostgreSQL.store({ pool: tracked.pool, encryptor })
  const key = {
    namespace: 'postgresql-client-release',
    providerId: 'salesforce',
    connectionId: 'connection',
  }
  const lookup = {
    namespace: key.namespace,
    stateDigest: 'missing',
    bindingDigest: 'missing',
    now: 1_000,
  }
  const initialize = await withRequest(
    { _tag: 'InitializeConnection' as const, key },
    'postgresql-client-release:initialize',
  )
  const remove = {
    _tag: 'RemoveConnection' as const,
    request: {
      requestId: 'postgresql-client-release:remove',
      inputDigest: 'postgresql-client-release:remove',
    },
    key,
    expectedGeneration: 0,
    expectedRevision: 0,
    removedAt: 1_000,
  }

  await Effect.runPromise(store.readConnection(key))
  await Effect.runPromise(store.inspectConnection(key))
  await Effect.runPromise(store.readAuthorizationAttempt(lookup))
  await Effect.runPromise(store.execute(initialize))
  await Effect.runPromise(store.executeCredentialOperation(remove))

  expect(tracked.metrics.acquired).toBe(5)
  expect(tracked.metrics.released).toBe(5)
  expect(tracked.metrics.active).toBe(0)
  await expect(pool.query('SELECT 1 AS available')).resolves.toMatchObject({
    rows: [{ available: 1 }],
  })
})

test('PostgreSQL store: rolls back partial writes and returns a secret-safe failure', async () => {
  const secretCanary = '__postgresql_raw_error_secret_canary__'
  const tracked = trackedPool((sql) => {
    if (sql.includes(`INSERT INTO "public"."${receiptsTable}"`)) {
      throw new Error(secretCanary)
    }
  })
  const store = PostgreSQL.store({ pool: tracked.pool, encryptor })
  const key = {
    namespace: 'postgresql-transaction-rollback',
    providerId: 'salesforce',
    connectionId: 'connection',
  }
  const command = await withRequest(
    { _tag: 'InitializeConnection' as const, key },
    'postgresql-transaction-rollback:initialize',
  )

  const failure = await Effect.runPromise(store.execute(command).pipe(Effect.flip))

  expect(failure).toBeInstanceOf(PostgreSQLStorageFailure)
  expect(failure).toMatchObject({ _tag: 'PostgreSQLStorageFailure', operation: 'execute' })
  expect(JSON.stringify(failure)).not.toContain(secretCanary)
  expect(tracked.traces.some(({ sql }) => sql === 'ROLLBACK')).toBe(true)
  expect(tracked.metrics.released).toBe(tracked.metrics.acquired)
  expect(tracked.metrics.active).toBe(0)
  await expect(rawConnectionRecord(key)).resolves.toMatchObject({ rows: [] })
  await expect(
    pool.query(
      `SELECT request_id FROM ${qualified('public', receiptsTable)}
       WHERE namespace = $1 AND request_id = $2`,
      [key.namespace, command.request.requestId],
    ),
  ).resolves.toMatchObject({ rows: [] })
})

test('PostgreSQL store: malformed persisted data fails closed without raw data', async () => {
  const store = PostgreSQL.store({ pool, encryptor })
  const key = {
    namespace: 'postgresql-malformed-secret-canary',
    providerId: 'salesforce',
    connectionId: 'connection',
  }
  await Effect.runPromise(
    store.execute(
      await withRequest(
        { _tag: 'InitializeConnection' as const, key },
        'postgresql-malformed:initialize',
      ),
    ),
  )
  await pool.query(
    `UPDATE ${qualified('public', connectionsTable)} SET record_json = $1
     WHERE storage_key = $2`,
    ['{"credentialEnvelope":"__plaintext_postgresql_secret_canary__"}', connectionStorageKey(key)],
  )

  const readFailure = await Effect.runPromise(store.readConnection(key).pipe(Effect.flip))
  const executeFailure = await Effect.runPromise(
    store
      .execute(
        await withRequest(
          { _tag: 'InitializeConnection' as const, key },
          'postgresql-malformed:after-corruption',
        ),
      )
      .pipe(Effect.flip),
  )

  expect(readFailure).toBeInstanceOf(PostgreSQLStorageFailure)
  expect(readFailure).toMatchObject({ _tag: 'PostgreSQLStorageFailure', operation: 'read' })
  expect(executeFailure).toMatchObject({
    _tag: 'PostgreSQLStorageFailure',
    operation: 'execute',
  })
  expect(JSON.stringify([readFailure, executeFailure])).not.toContain(
    '__plaintext_postgresql_secret_canary__',
  )
})
