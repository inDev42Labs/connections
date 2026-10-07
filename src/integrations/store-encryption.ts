import { Configuration } from '../configuration/index.js'
import type { CredentialEncryptor } from '../core/contracts/encryptor.js'
import { AesGcm, type EncryptionFailure } from '../encryptors/aes-gcm/index.js'

export type StoreEncryptionFailure = EncryptionFailure

export type StoreEncryptionOptions<Error, Requirements> =
  | { readonly encryptionKey: string; readonly encryptor?: never }
  | { readonly encryptor: CredentialEncryptor<Error, Requirements>; readonly encryptionKey?: never }

export function encryptorFromKey(
  encryptionKey: string | (() => string),
): CredentialEncryptor<EncryptionFailure, never> {
  return AesGcm.encryptor({
    key: Configuration.secret(() => {
      const key = typeof encryptionKey === 'function' ? encryptionKey() : encryptionKey
      return typeof key === 'string' ? key : undefined
    }),
  })
}
