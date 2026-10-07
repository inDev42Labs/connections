import { Data, Effect, Redacted } from 'effect'
import type {
  CredentialEncryptor,
  CredentialEnvelope,
  EncryptionContext,
} from '../../core/contracts/encryptor.js'

const algorithm = 'AES-256-GCM' as const
const version = 1 as const
const base64Pattern = /^(?:[A-Za-z\d+/]{4})*(?:[A-Za-z\d+/]{2}==|[A-Za-z\d+/]{3}=)?$/

export class EncryptionFailure extends Data.TaggedError('EncryptionFailure')<{
  readonly reason:
    | 'InvalidKey'
    | 'MalformedEnvelope'
    | 'UnknownKey'
    | 'EncryptionFailed'
    | 'AuthenticationFailed'
}> {}

function encodeBase64(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary)
}

function decodeBase64(value: string): Uint8Array | null {
  if (!base64Pattern.test(value)) return null
  try {
    const binary = atob(value)
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0))
    return encodeBase64(bytes) === value ? bytes : null
  } catch {
    return null
  }
}

function arrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const buffer = new ArrayBuffer(bytes.byteLength)
  new Uint8Array(buffer).set(bytes)
  return buffer
}

function associatedData(context: EncryptionContext, keyId: string): ArrayBuffer {
  return arrayBuffer(
    new TextEncoder().encode(
      JSON.stringify([
        '@indev42/connections:aes-gcm-envelope',
        version,
        algorithm,
        keyId,
        context.namespace,
        context.providerId,
        context.connectionId,
        context.generation,
        context.purpose,
      ]),
    ),
  )
}

function parseEnvelope(envelope: unknown): CredentialEnvelope | null {
  if (typeof envelope !== 'object' || envelope === null) return null
  const candidate = {
    version: Reflect.get(envelope, 'version'),
    algorithm: Reflect.get(envelope, 'algorithm'),
    keyId: Reflect.get(envelope, 'keyId'),
    iv: Reflect.get(envelope, 'iv'),
    ciphertext: Reflect.get(envelope, 'ciphertext'),
  }
  if (
    candidate.version !== version ||
    candidate.algorithm !== algorithm ||
    typeof candidate.keyId !== 'string' ||
    typeof candidate.iv !== 'string' ||
    typeof candidate.ciphertext !== 'string'
  ) {
    return null
  }
  return candidate
}

function importKey(encoded: Redacted.Redacted<string>) {
  const bytes = decodeBase64(Redacted.value(encoded))
  if (bytes === null || bytes.byteLength !== 32) {
    return Effect.fail(new EncryptionFailure({ reason: 'InvalidKey' }))
  }
  return Effect.tryPromise({
    try: () =>
      crypto.subtle.importKey('raw', arrayBuffer(bytes), { name: 'AES-GCM' }, false, [
        'encrypt',
        'decrypt',
      ]),
    catch: () => new EncryptionFailure({ reason: 'InvalidKey' }),
  })
}

export function encryptor<KeyError, Requirements>(options: {
  readonly key: Effect.Effect<Redacted.Redacted<string>, KeyError, Requirements>
  readonly keyId?: string
}): CredentialEncryptor<EncryptionFailure, Requirements> {
  const keyId = options.keyId ?? 'default'
  const resolveKey = options.key.pipe(
    Effect.mapError(() => new EncryptionFailure({ reason: 'InvalidKey' })),
    Effect.flatMap(importKey),
  )

  const configured: CredentialEncryptor<EncryptionFailure, Requirements> = {
    encrypt: (plaintext: Redacted.Redacted<string>, context: EncryptionContext) =>
      Effect.gen(function* () {
        const key = yield* resolveKey
        const iv = crypto.getRandomValues(new Uint8Array(12))
        const ciphertext = yield* Effect.tryPromise({
          try: () =>
            crypto.subtle.encrypt(
              {
                name: 'AES-GCM',
                iv: arrayBuffer(iv),
                additionalData: associatedData(context, keyId),
              },
              key,
              arrayBuffer(new TextEncoder().encode(Redacted.value(plaintext))),
            ),
          catch: () => new EncryptionFailure({ reason: 'EncryptionFailed' }),
        })
        return {
          version,
          algorithm,
          keyId,
          iv: encodeBase64(iv),
          ciphertext: encodeBase64(new Uint8Array(ciphertext)),
        }
      }),
    decrypt: (unparsedEnvelope: unknown, context: EncryptionContext) => {
      const envelope = parseEnvelope(unparsedEnvelope)
      if (envelope === null) {
        return Effect.fail(new EncryptionFailure({ reason: 'MalformedEnvelope' }))
      }
      if (envelope.keyId !== keyId) {
        return Effect.fail(new EncryptionFailure({ reason: 'UnknownKey' }))
      }
      const iv = decodeBase64(envelope.iv)
      const ciphertext = decodeBase64(envelope.ciphertext)
      if (
        iv === null ||
        iv.byteLength !== 12 ||
        ciphertext === null ||
        ciphertext.byteLength < 16
      ) {
        return Effect.fail(new EncryptionFailure({ reason: 'MalformedEnvelope' }))
      }
      return Effect.gen(function* () {
        const key = yield* resolveKey
        const plaintext = yield* Effect.tryPromise({
          try: () =>
            crypto.subtle.decrypt(
              {
                name: 'AES-GCM',
                iv: arrayBuffer(iv),
                additionalData: associatedData(context, envelope.keyId),
              },
              key,
              arrayBuffer(ciphertext),
            ),
          catch: () => new EncryptionFailure({ reason: 'AuthenticationFailed' }),
        })
        return Redacted.make(new TextDecoder().decode(plaintext))
      })
    },
  }
  return Object.freeze(configured)
}
