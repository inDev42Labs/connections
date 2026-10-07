import { Buffer } from 'node:buffer'
import { Effect, Redacted } from 'effect'
import { describe, expect, test, vi } from 'vitest'
import { AesGcm, EncryptionFailure } from '../../src/encryptors/aes-gcm/index.js'
import { Configuration } from '../../src/configuration/index.js'

const key = Buffer.from(new Uint8Array(32).fill(42)).toString('base64')
const context = {
  namespace: 'salesforce-production',
  providerId: 'salesforce',
  connectionId: 'conn_acme',
  generation: 7,
  purpose: 'credentials',
} as const

function makeEncryptor(keySource: () => string = () => key) {
  return AesGcm.encryptor({
    key: Configuration.secret(keySource),
    keyId: 'primary',
  })
}

async function expectEncryptionFailure(effect: Effect.Effect<unknown, EncryptionFailure>) {
  const failure = await Effect.runPromise(Effect.flip(effect))
  expect(failure).toBeInstanceOf(EncryptionFailure)
  return failure
}

describe('AES-256-GCM credential envelopes', () => {
  test('round trips a redacted value without plaintext in the serializable envelope', async () => {
    const encryptor = makeEncryptor()
    const plaintext = '__connections_access_and_refresh_secret__'

    const envelope = await Effect.runPromise(encryptor.encrypt(Redacted.make(plaintext), context))
    const decrypted = await Effect.runPromise(encryptor.decrypt(envelope, context))

    expect(envelope).toMatchObject({
      version: 1,
      algorithm: 'AES-256-GCM',
      keyId: 'primary',
    })
    expect(JSON.stringify(envelope)).not.toContain(plaintext)
    expect(Redacted.value(decrypted)).toBe(plaintext)
  })

  test('fails closed when envelope metadata, nonce, or ciphertext is altered', async () => {
    expect.assertions(4)
    const encryptor = makeEncryptor()
    const envelope = await Effect.runPromise(
      encryptor.encrypt(Redacted.make('credential payload'), context),
    )

    for (const altered of [
      { ...envelope, algorithm: 'AES-128-GCM' },
      { ...envelope, version: 2 },
      { ...envelope, iv: `${envelope.iv.slice(0, -2)}AA` },
      { ...envelope, ciphertext: `${envelope.ciphertext.slice(0, -2)}AA` },
    ]) {
      await expectEncryptionFailure(encryptor.decrypt(altered, context))
    }
  })

  test('binds an envelope to its connection and lifecycle generation', async () => {
    expect.assertions(2)
    const encryptor = makeEncryptor()
    const envelope = await Effect.runPromise(
      encryptor.encrypt(Redacted.make('credential payload'), context),
    )

    await expectEncryptionFailure(
      encryptor.decrypt(envelope, { ...context, connectionId: 'conn_globex' }),
    )
    await expectEncryptionFailure(
      encryptor.decrypt(envelope, { ...context, generation: context.generation + 1 }),
    )
  })

  test('rejects malformed base64 and key material that is not exactly 32 bytes', async () => {
    expect.assertions(3)
    for (const malformed of [
      'not base64!',
      Buffer.from(new Uint8Array(16).fill(42)).toString('base64'),
      `${key}=`,
    ]) {
      await expectEncryptionFailure(
        makeEncryptor(() => malformed).encrypt(Redacted.make('credential payload'), context),
      )
    }
  })

  test('authenticates a known key ID even when aliases resolve to the same key', async () => {
    expect.assertions(2)
    const envelope = await Effect.runPromise(
      makeEncryptor().encrypt(Redacted.make('credential payload'), context),
    )
    const aliasedEncryptor = AesGcm.encryptor({
      key: Configuration.secret(() => key),
      keyId: 'secondary',
    })

    const failure = await expectEncryptionFailure(
      aliasedEncryptor.decrypt({ ...envelope, keyId: 'secondary' }, context),
    )

    expect(failure.reason).toBe('AuthenticationFailed')
  })

  test('rejects an unknown key ID without resolving configured key material', async () => {
    expect.assertions(3)
    const keyAccess = vi.fn<() => string>(() => key)
    const encryptor = makeEncryptor(keyAccess)
    const envelope = await Effect.runPromise(
      encryptor.encrypt(Redacted.make('credential payload'), context),
    )
    keyAccess.mockClear()

    const failure = await expectEncryptionFailure(
      encryptor.decrypt({ ...envelope, keyId: 'retired' }, context),
    )

    expect(failure.reason).toBe('UnknownKey')
    expect(keyAccess).not.toHaveBeenCalled()
  })
})
