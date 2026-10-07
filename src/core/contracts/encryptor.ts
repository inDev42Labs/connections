import type { Effect, Redacted } from 'effect'

export interface EncryptionContext {
  readonly namespace: string
  readonly providerId: string
  readonly connectionId: string
  readonly generation: number
  readonly purpose: 'credentials' | 'authorization-pkce'
}

export interface CredentialEnvelope {
  readonly version: 1
  readonly algorithm: 'AES-256-GCM'
  readonly keyId: string
  readonly iv: string
  readonly ciphertext: string
}

export interface CredentialEncryptor<Error, Requirements> {
  readonly encrypt: (
    plaintext: Redacted.Redacted<string>,
    context: EncryptionContext,
  ) => Effect.Effect<CredentialEnvelope, Error, Requirements>
  readonly decrypt: (
    envelope: unknown,
    context: EncryptionContext,
  ) => Effect.Effect<Redacted.Redacted<string>, Error, Requirements>
}
