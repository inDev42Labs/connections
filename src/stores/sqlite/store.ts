import { Data, Effect } from 'effect'
import type { CredentialEncryptor } from '../../core/contracts/encryptor.js'
import type { ConnectionStore } from '../../core/contracts/store.js'
import {
  projectAuthorizationAttempt,
  projectConnection,
  projectConnectionInspection,
} from '../internal/transition-kernel.js'
import type { StoreEncryptionOptions } from '../../integrations/store-encryption.js'
import type { SynchronousSQLiteDatabase } from './database.js'
import { SQLitePersistence } from './persistence.js'

export class SQLiteStorageFailure extends Data.TaggedError('SQLiteStorageFailure')<{
  readonly operation: 'read' | 'inspect' | 'attempt' | 'execute'
}> {}

export type SQLiteStoreOptions<EncryptorError, EncryptorRequirements> = {
  readonly database: SynchronousSQLiteDatabase
} & StoreEncryptionOptions<EncryptorError, EncryptorRequirements>

export interface SQLiteStoreEncryptorOptions<EncryptorError, EncryptorRequirements> {
  readonly database: SynchronousSQLiteDatabase
  readonly encryptor: CredentialEncryptor<EncryptorError, EncryptorRequirements>
}

function storageEffect<Value>(
  operation: SQLiteStorageFailure['operation'],
  evaluate: () => Value,
): Effect.Effect<Value, SQLiteStorageFailure> {
  return Effect.try({
    try: evaluate,
    catch: () => new SQLiteStorageFailure({ operation }),
  })
}

export function makeSQLiteStore<EncryptorError, EncryptorRequirements>(
  options: SQLiteStoreEncryptorOptions<EncryptorError, EncryptorRequirements>,
  persistence = new SQLitePersistence(options.database),
): ConnectionStore<
  SQLiteStorageFailure | EncryptorError,
  EncryptorRequirements,
  SQLiteStorageFailure,
  never
> {
  const configured: ConnectionStore<
    SQLiteStorageFailure | EncryptorError,
    EncryptorRequirements,
    SQLiteStorageFailure,
    never
  > = {
    readConnection: (key) =>
      storageEffect('read', () => projectConnection(persistence.connection(key))),
    inspectConnection: (key) =>
      storageEffect('inspect', () => projectConnectionInspection(persistence.connection(key))),
    readAuthorizationAttempt: (lookup) =>
      storageEffect('attempt', () => {
        const stored = persistence.authorizationAttempt(lookup)
        const current = stored === null ? null : persistence.connection(stored.attempt.key)
        return projectAuthorizationAttempt(stored, current, lookup)
      }),
    protect: (plaintext, context) =>
      Effect.suspend(() => options.encryptor.encrypt(plaintext, context)),
    unprotect: (envelope, context) =>
      Effect.suspend(() => options.encryptor.decrypt(envelope, context)),
    execute: (command) => storageEffect('execute', () => persistence.execute(command)),
    executeCredentialOperation: (command) =>
      storageEffect('execute', () => persistence.executeCredentialOperation(command)),
  }
  return Object.freeze(configured)
}
