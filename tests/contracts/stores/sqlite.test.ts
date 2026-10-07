import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Effect, Redacted } from 'effect'
import { expect, onTestFinished, test } from 'vitest'
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
import { SQLite, SQLiteStorageFailure } from '../../../src/stores/sqlite/index.js'
import { credentialOperationStoreConformance, storeConformance } from './conformance.js'

const encryptor = AesGcm.encryptor({
  key: Effect.succeed(Redacted.make('KioqKioqKioqKioqKioqKioqKioqKioqKioqKioqKio=')),
  keyId: 'sqlite-conformance',
})

interface TemporaryDatabase {
  readonly database: DatabaseSync
  readonly path: string
}

function temporaryDatabase(): TemporaryDatabase {
  const directory = mkdtempSync(join(tmpdir(), 'connections-sqlite-'))
  const path = join(directory, 'connections.sqlite')
  const databases: DatabaseSync[] = []
  const database = new DatabaseSync(path, { timeout: 5_000 })
  databases.push(database)
  onTestFinished(() => {
    for (const owned of databases) {
      if (owned.isOpen) owned.close()
    }
    rmSync(directory, { recursive: true, force: true })
  })
  return { database, path }
}

function additionalDatabase(fixture: TemporaryDatabase): DatabaseSync {
  const database = new DatabaseSync(fixture.path, { timeout: 5_000 })
  onTestFinished(() => {
    if (database.isOpen) database.close()
  })
  return database
}

function makeTarget() {
  const { database } = temporaryDatabase()
  return {
    store: SQLite.store({ database, encryptor }),
    run: <Value, Error>(effect: Effect.Effect<Value, Error>) => Effect.runPromise(effect),
    pruneReceipts: () => database.exec('DELETE FROM indev42_connections_sqlite_receipts'),
  }
}

storeConformance('SQLite store', makeTarget)
credentialOperationStoreConformance('SQLite store', makeTarget)

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

function authorizationAttempt(key: ConnectionKey): AuthorizationAttempt {
  return {
    schemaVersion: 1,
    stateDigest: 'state:atomic-admission',
    key,
    generation: 0,
    intent: 'enroll',
    bindingDigest: 'binding:atomic-admission',
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

test('SQLite store: direct encryption key protects and unprotects credentials', async () => {
  const { database } = temporaryDatabase()
  const store = SQLite.store({
    database,
    encryptionKey: 'KioqKioqKioqKioqKioqKioqKioqKioqKioqKioqKio=',
  })
  const context = {
    namespace: 'direct-key',
    providerId: 'salesforce',
    connectionId: 'connection',
    generation: 0,
    purpose: 'credentials' as const,
  }
  const plaintext = 'direct-key-sqlite-credential'
  const envelope = await Effect.runPromise(store.protect(Redacted.make(plaintext), context))

  expect(envelope.algorithm).toBe('AES-256-GCM')
  expect(JSON.stringify(envelope)).not.toContain(plaintext)
  await expect(
    Effect.runPromise(store.unprotect(envelope, context)).then(Redacted.value),
  ).resolves.toBe(plaintext)
})

test('SQLite store: invalid direct encryption key fails safely', async () => {
  const invalidKey = 'not-a-valid-aes-key'
  const store = SQLite.store({ database: temporaryDatabase().database, encryptionKey: invalidKey })
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

test('SQLite store: initializes lazily and leaves the consumer database open', async () => {
  const fixture = temporaryDatabase()
  let databaseCalls = 0
  const database = {
    exec: (sql: string) => {
      databaseCalls++
      return fixture.database.exec(sql)
    },
    prepare: (sql: string) => {
      databaseCalls++
      return fixture.database.prepare(sql)
    },
  }
  const store = SQLite.store({ database, encryptor })

  expect(databaseCalls).toBe(0)
  const read = store.readConnection({
    namespace: 'lazy',
    providerId: 'salesforce',
    connectionId: 'connection',
  })
  expect(databaseCalls).toBe(0)
  await Effect.runPromise(read)
  expect(databaseCalls).toBeGreaterThan(0)
  expect(fixture.database.prepare('SELECT 1 AS available').get()).toEqual({ available: 1 })
})

test('SQLite store: persists versioned records across database and store recreation', async () => {
  const fixture = temporaryDatabase()
  const key = {
    namespace: 'persistence',
    providerId: 'salesforce',
    connectionId: 'connection',
  }
  const attempt = { ...authorizationAttempt(key), stateDigest: 'state:persistence' }
  const command = await withRequest(
    { _tag: 'CreateAuthorizationAttempt' as const, attempt },
    'create-attempt',
  )
  const firstStore = SQLite.store({ database: fixture.database, encryptor })
  const created = await Effect.runPromise(firstStore.execute(command))
  fixture.database.close()

  const reopened = additionalDatabase(fixture)
  const recreatedStore = SQLite.store({ database: reopened, encryptor })
  await expect(Effect.runPromise(recreatedStore.readConnection(key))).resolves.toMatchObject({
    schemaVersion: 1,
    key,
    generation: 0,
    revision: 1,
    authorization: { _tag: 'NotAuthorized' },
  })
  await expect(
    Effect.runPromise(
      recreatedStore.readAuthorizationAttempt({
        namespace: key.namespace,
        stateDigest: attempt.stateDigest,
        bindingDigest: attempt.bindingDigest,
        now: 1_500,
      }),
    ),
  ).resolves.toEqual(attempt)
  await expect(Effect.runPromise(recreatedStore.execute(command))).resolves.toEqual(created)
  for (const table of [
    'indev42_connections_sqlite_connections',
    'indev42_connections_sqlite_authorization_attempts',
    'indev42_connections_sqlite_receipts',
  ]) {
    expect(reopened.prepare(`SELECT schema_version FROM ${table}`).get()).toEqual({
      schema_version: 1,
    })
  }
})

test('SQLite store: a stable direct encryption key decrypts credentials after database reopen', async () => {
  const fixture = temporaryDatabase()
  const encryptionKey = 'KioqKioqKioqKioqKioqKioqKioqKioqKioqKioqKio='
  const key = {
    namespace: 'direct-key-reopen',
    providerId: 'salesforce',
    connectionId: 'connection',
  }
  const context = { ...key, generation: 0, purpose: 'credentials' as const }
  const plaintext = 'persisted-direct-key-credential'
  const firstStore = SQLite.store({ database: fixture.database, encryptionKey })
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
  fixture.database.close()

  const reopenedDatabase = additionalDatabase(fixture)
  const reopenedStore = SQLite.store({ database: reopenedDatabase, encryptionKey })
  const connection = await Effect.runPromise(reopenedStore.readConnection(key))
  if (connection === null || connection.credentialEnvelope === null) {
    throw new Error('Expected persisted direct-key credential')
  }
  const decrypted = await Effect.runPromise(
    reopenedStore.unprotect(connection.credentialEnvelope, context),
  )

  expect(Redacted.value(decrypted)).toBe(plaintext)
})

test('SQLite store: admits one winner across independent database handles', async () => {
  const fixture = temporaryDatabase()
  const secondDatabase = additionalDatabase(fixture)
  const firstStore = SQLite.store({ database: fixture.database, encryptor })
  const secondStore = SQLite.store({ database: secondDatabase, encryptor })
  const key = {
    namespace: 'atomic-admission',
    providerId: 'salesforce',
    connectionId: 'connection',
  }
  const attempt = authorizationAttempt(key)
  await Effect.runPromise(
    firstStore.execute(
      await withRequest({ _tag: 'CreateAuthorizationAttempt', attempt }, 'create-attempt'),
    ),
  )
  const admission = {
    stateDigest: attempt.stateDigest,
    key,
    intent: 'enroll' as const,
    generation: 0,
    admissionId: 'admission',
    admittedAt: 1_500,
    admissionExpiresAt: 9_000,
  }
  const first = await withRequest(admissionCommand(admission, 'first'), 'admit:first')
  const second = await withRequest(admissionCommand(admission, 'second'), 'admit:second')

  const results = await Promise.all([
    Effect.runPromise(firstStore.execute(first)),
    Effect.runPromise(secondStore.execute(second)),
  ])

  expect(results.filter((result) => result._tag === 'AuthorizationAttemptAdmitted')).toHaveLength(1)
  expect(results.filter((result) => result._tag === 'StoreConflict')).toEqual([
    { _tag: 'StoreConflict', reason: 'ConditionChanged' },
  ])
})

test('SQLite store: malformed persisted records fail closed with safe failures', async () => {
  const { database } = temporaryDatabase()
  const store = SQLite.store({ database, encryptor })
  const key = {
    namespace: 'malformed-secret-canary',
    providerId: 'salesforce',
    connectionId: 'connection',
  }
  await Effect.runPromise(
    store.execute(await withRequest({ _tag: 'InitializeConnection', key }, 'initialize')),
  )
  const storageKey = connectionStorageKey(key)
  const original = database
    .prepare(
      `SELECT record_json FROM indev42_connections_sqlite_connections
       WHERE storage_key = ?`,
    )
    .get(storageKey)
  if (typeof original?.record_json !== 'string') throw new Error('Expected stored connection')
  database
    .prepare(
      `UPDATE indev42_connections_sqlite_connections
       SET record_json = ? WHERE storage_key = ?`,
    )
    .run('{"credentialEnvelope":"__plaintext_secret_canary__"}', storageKey)

  const readFailure = await Effect.runPromise(store.readConnection(key).pipe(Effect.flip))
  const executeFailure = await Effect.runPromise(
    store
      .execute(await withRequest({ _tag: 'InitializeConnection', key }, 'after-corruption'))
      .pipe(Effect.flip),
  )

  expect(readFailure).toBeInstanceOf(SQLiteStorageFailure)
  expect(readFailure).toMatchObject({ _tag: 'SQLiteStorageFailure', operation: 'read' })
  expect(executeFailure).toMatchObject({ _tag: 'SQLiteStorageFailure', operation: 'execute' })
  expect(JSON.stringify([readFailure, executeFailure])).not.toContain('__plaintext_secret_canary__')

  database
    .prepare(
      `UPDATE indev42_connections_sqlite_connections
       SET record_json = ? WHERE storage_key = ?`,
    )
    .run(original.record_json, storageKey)
  await expect(
    Effect.runPromise(
      store.execute(await withRequest({ _tag: 'InitializeConnection', key }, 'after-rollback')),
    ),
  ).resolves.toEqual({ _tag: 'StoreConflict', reason: 'ConditionChanged' })
})

test('SQLite store: delegates protection lazily to the caller encryptor', async () => {
  const { database } = temporaryDatabase()
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
  const store = SQLite.store({ database, encryptor: delegatedEncryptor })
  const context = {
    namespace: 'delegation',
    providerId: 'salesforce',
    connectionId: 'connection',
    generation: 0,
    purpose: 'credentials' as const,
  }
  const protectedEffect = store.protect(Redacted.make('plaintext'), context)
  const unprotectedEffect = store.unprotect(envelope, context)

  expect(calls).toEqual([])
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
})
