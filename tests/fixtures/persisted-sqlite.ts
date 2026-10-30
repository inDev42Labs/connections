import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Effect, Redacted } from 'effect'
import { onTestFinished } from 'vitest'
import { connectionStorageKey } from '../../src/stores/index.js'
import { SQLite } from '../../src/stores/sqlite/index.js'

/** Owns disposable persistence and historical/corrupt record setup, not lifecycle behavior. */
export async function makePersistedSQLite() {
  const directory = mkdtempSync(join(tmpdir(), 'connections-persisted-record-'))
  const path = join(directory, 'connections.sqlite')
  let database = new DatabaseSync(path)
  onTestFinished(() => {
    if (database.isOpen) database.close()
    rmSync(directory, { recursive: true, force: true })
  })
  const encryptionKey = 'KioqKioqKioqKioqKioqKioqKioqKioqKioqKioqKio='
  const key = { namespace: 'default', providerId: 'persisted-provider', connectionId: 'connection' }
  const openStore = () => SQLite.store({ database, encryptionKey })
  let store = openStore()
  await Effect.runPromise(store.readConnection(key))
  const credentialEnvelope = await Effect.runPromise(
    store.protect(Redacted.make(JSON.stringify({ schemaVersion: 1, apiKey: 'saved-key' })), {
      ...key,
      generation: 0,
      purpose: 'credentials',
    }),
  )
  // This historical version deliberately predates credentialAcquiredAt.
  const authorizedRecord = {
    schemaVersion: 1,
    key,
    generation: 0,
    revision: 4,
    authorization: { _tag: 'Authorized', credentialExpiresAt: null },
    credentialEnvelope,
    credentialOperation: null,
    authorizationAttemptStateDigest: null,
  }
  return {
    key,
    authorizedRecord,
    get store() {
      return store
    },
    reopen: () => {
      database.close()
      database = new DatabaseSync(path)
      store = openStore()
    },
    seedConnection: (record: Record<string, unknown>) => {
      database
        .prepare(`INSERT OR REPLACE INTO indev42_connections_sqlite_connections
        (storage_key, schema_version, record_json) VALUES (?, 1, ?)`)
        .run(connectionStorageKey(key), JSON.stringify(record))
    },
    corruptReceiptResult: (requestId: string, result: unknown) => {
      database
        .prepare(`UPDATE indev42_connections_sqlite_receipts SET result_json = ?
        WHERE namespace = ? AND request_id = ?`)
        .run(JSON.stringify(result), key.namespace, requestId)
    },
  }
}
