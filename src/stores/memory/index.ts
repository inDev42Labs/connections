import type { ConnectionStore } from '../../core/contracts/store.js'
import type { CredentialEncryptor } from '../../core/contracts/encryptor.js'
import {
  encryptorFromKey,
  type StoreEncryptionFailure,
} from '../../integrations/store-encryption.js'
import { MemoryPersistence } from './persistence.js'
import { makeMemoryStore, type MemoryStoreOptions } from './store.js'

export type { MemoryStoreOptions } from './store.js'

interface MemoryEncryptionKeyOptions {
  readonly encryptionKey: string
  readonly encryptor?: never
}

interface MemoryEncryptorOptions<Error, Requirements> {
  readonly encryptor: CredentialEncryptor<Error, Requirements>
  readonly encryptionKey?: never
}

export function store(
  options: MemoryEncryptionKeyOptions,
): ConnectionStore<StoreEncryptionFailure, never, never, never>
export function store<Error, Requirements>(
  options: MemoryEncryptorOptions<Error, Requirements>,
): ConnectionStore<Error, Requirements, never, never>
export function store<Error, Requirements>(
  options: MemoryStoreOptions<Error, Requirements>,
): ConnectionStore<Error | StoreEncryptionFailure, Requirements, never, never> {
  const persistence = new MemoryPersistence()
  if (typeof options.encryptionKey === 'string') {
    return makeMemoryStore({ encryptor: encryptorFromKey(options.encryptionKey) }, persistence)
  }
  return makeMemoryStore(options, persistence)
}

export const Memory = { store } as const
