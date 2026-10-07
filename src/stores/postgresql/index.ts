import type { CredentialEncryptor } from '../../core/contracts/encryptor.js'
import type { ConnectionStore } from '../../core/contracts/store.js'
import {
  encryptorFromKey,
  type StoreEncryptionFailure,
} from '../../integrations/store-encryption.js'
import {
  makePostgreSQLStore,
  type PostgreSQLStorageFailure,
  type PostgreSQLStoreOptions,
} from './store.js'
import type { PostgreSQLPool } from './client.js'

export type {
  PostgreSQLClient,
  PostgreSQLParameter,
  PostgreSQLPool,
  PostgreSQLQueryResult,
  PostgreSQLRow,
} from './client.js'
export { PostgreSQLStorageFailure, type PostgreSQLStoreOptions } from './store.js'

interface PostgreSQLEncryptionKeyOptions {
  readonly pool: PostgreSQLPool
  readonly schema?: string
  readonly encryptionKey: string
  readonly encryptor?: never
}

interface PostgreSQLEncryptorOptions<EncryptorError, EncryptorRequirements> {
  readonly pool: PostgreSQLPool
  readonly schema?: string
  readonly encryptor: CredentialEncryptor<EncryptorError, EncryptorRequirements>
  readonly encryptionKey?: never
}

export function store(
  options: PostgreSQLEncryptionKeyOptions,
): ConnectionStore<
  PostgreSQLStorageFailure | StoreEncryptionFailure,
  never,
  PostgreSQLStorageFailure,
  never
>
export function store<EncryptorError, EncryptorRequirements>(
  options: PostgreSQLEncryptorOptions<EncryptorError, EncryptorRequirements>,
): ConnectionStore<
  PostgreSQLStorageFailure | EncryptorError,
  EncryptorRequirements,
  PostgreSQLStorageFailure,
  never
>
export function store<EncryptorError, EncryptorRequirements>(
  options: PostgreSQLStoreOptions<EncryptorError, EncryptorRequirements>,
): ConnectionStore<
  PostgreSQLStorageFailure | EncryptorError | StoreEncryptionFailure,
  EncryptorRequirements,
  PostgreSQLStorageFailure,
  never
> {
  if (typeof options.encryptionKey === 'string') {
    return makePostgreSQLStore({
      pool: options.pool,
      ...(options.schema === undefined ? {} : { schema: options.schema }),
      encryptor: encryptorFromKey(options.encryptionKey),
    })
  }
  return makePostgreSQLStore(options)
}

export const PostgreSQL = { store } as const
