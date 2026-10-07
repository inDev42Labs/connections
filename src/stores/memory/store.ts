import { Effect } from 'effect'
import type { CredentialEncryptor } from '../../core/contracts/encryptor.js'
import type { ConnectionStore } from '../../core/contracts/store.js'
import type { StoreEncryptionOptions } from '../../integrations/store-encryption.js'
import {
  projectAuthorizationAttempt,
  projectConnection,
  projectConnectionInspection,
} from '../internal/transition-kernel.js'
import { MemoryPersistence } from './persistence.js'

export type MemoryStoreOptions<Error, Requirements> = StoreEncryptionOptions<Error, Requirements>

export interface MemoryStoreEncryptorOptions<Error, Requirements> {
  readonly encryptor: CredentialEncryptor<Error, Requirements>
}

export function makeMemoryStore<Error, Requirements>(
  options: MemoryStoreEncryptorOptions<Error, Requirements>,
  persistence: MemoryPersistence,
): ConnectionStore<Error, Requirements, never, never> {
  const configured: ConnectionStore<Error, Requirements, never, never> = {
    readConnection: (key) => Effect.sync(() => projectConnection(persistence.connection(key))),
    inspectConnection: (key) =>
      Effect.sync(() => projectConnectionInspection(persistence.connection(key))),
    readAuthorizationAttempt: (lookup) =>
      Effect.sync(() => {
        const stored = persistence.authorizationAttempt(lookup)
        const current = stored === null ? null : persistence.connection(stored.attempt.key)
        return projectAuthorizationAttempt(stored, current, lookup)
      }),
    protect: (plaintext, context) => options.encryptor.encrypt(plaintext, context),
    unprotect: (envelope, context) => options.encryptor.decrypt(envelope, context),
    execute: (command) => Effect.sync(() => persistence.execute(command)),
    executeCredentialOperation: (command) =>
      Effect.sync(() => persistence.executeCredentialOperation(command)),
  }
  return Object.freeze(configured)
}
