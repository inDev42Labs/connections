import { Data, Effect } from 'effect'
import type { CredentialEncryptor } from '../../core/contracts/encryptor.js'
import type { ConnectionStore } from '../../core/contracts/store.js'
import {
  projectAuthorizationAttempt,
  projectConnection,
  projectConnectionInspection,
} from '../internal/transition-kernel.js'
import type { StoreEncryptionOptions } from '../../integrations/store-encryption.js'
import type { PostgreSQLPool } from './client.js'
import { PostgreSQLPersistence } from './persistence.js'

export class PostgreSQLStorageFailure extends Data.TaggedError('PostgreSQLStorageFailure')<{
  readonly operation: 'read' | 'inspect' | 'attempt' | 'execute'
}> {}

export type PostgreSQLStoreOptions<EncryptorError, EncryptorRequirements> = {
  readonly pool: PostgreSQLPool
  readonly schema?: string
} & StoreEncryptionOptions<EncryptorError, EncryptorRequirements>

export interface PostgreSQLStoreEncryptorOptions<EncryptorError, EncryptorRequirements> {
  readonly pool: PostgreSQLPool
  readonly encryptor: CredentialEncryptor<EncryptorError, EncryptorRequirements>
  readonly schema?: string
}

function storageEffect<Value>(
  operation: PostgreSQLStorageFailure['operation'],
  evaluate: () => Promise<Value>,
): Effect.Effect<Value, PostgreSQLStorageFailure> {
  return Effect.tryPromise({
    try: evaluate,
    catch: () => new PostgreSQLStorageFailure({ operation }),
  })
}

export function makePostgreSQLStore<EncryptorError, EncryptorRequirements>(
  options: PostgreSQLStoreEncryptorOptions<EncryptorError, EncryptorRequirements>,
  persistence = new PostgreSQLPersistence(options.pool, options.schema),
): ConnectionStore<
  PostgreSQLStorageFailure | EncryptorError,
  EncryptorRequirements,
  PostgreSQLStorageFailure,
  never
> {
  const configured: ConnectionStore<
    PostgreSQLStorageFailure | EncryptorError,
    EncryptorRequirements,
    PostgreSQLStorageFailure,
    never
  > = {
    readConnection: (key) =>
      storageEffect('read', async () => projectConnection(await persistence.connection(key))),
    inspectConnection: (key) =>
      storageEffect('inspect', async () =>
        projectConnectionInspection(await persistence.connection(key)),
      ),
    readAuthorizationAttempt: (lookup) =>
      storageEffect('attempt', async () => {
        const records = await persistence.authorizationAttemptWithConnection(lookup)
        return projectAuthorizationAttempt(records.attempt, records.connection, lookup)
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
