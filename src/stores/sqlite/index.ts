import type { CredentialEncryptor } from '../../core/contracts/encryptor.js'
import type { ConnectionStore } from '../../core/contracts/store.js'
import {
  encryptorFromKey,
  type StoreEncryptionFailure,
} from '../../integrations/store-encryption.js'
import { makeSQLiteStore, type SQLiteStorageFailure, type SQLiteStoreOptions } from './store.js'
import type { SynchronousSQLiteDatabase } from './database.js'

export type {
  SQLiteBinding,
  SynchronousSQLiteDatabase,
  SynchronousSQLiteStatement,
} from './database.js'
export { SQLiteStorageFailure, type SQLiteStoreOptions } from './store.js'

interface SQLiteEncryptionKeyOptions {
  readonly database: SynchronousSQLiteDatabase
  readonly encryptionKey: string
  readonly encryptor?: never
}

interface SQLiteEncryptorOptions<EncryptorError, EncryptorRequirements> {
  readonly database: SynchronousSQLiteDatabase
  readonly encryptor: CredentialEncryptor<EncryptorError, EncryptorRequirements>
  readonly encryptionKey?: never
}

export function store(
  options: SQLiteEncryptionKeyOptions,
): ConnectionStore<
  SQLiteStorageFailure | StoreEncryptionFailure,
  never,
  SQLiteStorageFailure,
  never
>
export function store<EncryptorError, EncryptorRequirements>(
  options: SQLiteEncryptorOptions<EncryptorError, EncryptorRequirements>,
): ConnectionStore<
  SQLiteStorageFailure | EncryptorError,
  EncryptorRequirements,
  SQLiteStorageFailure,
  never
>
export function store<EncryptorError, EncryptorRequirements>(
  options: SQLiteStoreOptions<EncryptorError, EncryptorRequirements>,
): ConnectionStore<
  SQLiteStorageFailure | EncryptorError | StoreEncryptionFailure,
  EncryptorRequirements,
  SQLiteStorageFailure,
  never
> {
  if (typeof options.encryptionKey === 'string') {
    return makeSQLiteStore({
      database: options.database,
      encryptor: encryptorFromKey(options.encryptionKey),
    })
  }
  return makeSQLiteStore(options)
}

export const SQLite = { store } as const
