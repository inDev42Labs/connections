import { Effect, Redacted } from 'effect'
import { expect, test } from 'vitest'
import { AesGcm, EncryptionFailure } from '../../../src/encryptors/aes-gcm/index.js'
import { digestStoreInput } from '../../../src/stores/index.js'
import { Memory } from '../../../src/stores/memory/index.js'
import { MemoryPersistence } from '../../../src/stores/memory/persistence.js'
import { makeMemoryStore } from '../../../src/stores/memory/store.js'
import { credentialOperationStoreConformance, storeConformance } from './conformance.js'

const encryptor = AesGcm.encryptor({
  key: Effect.succeed(Redacted.make('KioqKioqKioqKioqKioqKioqKioqKioqKioqKioqKio=')),
  keyId: 'memory-conformance',
})

function makeTarget() {
  const persistence = new MemoryPersistence()
  return {
    store: makeMemoryStore({ encryptor }, persistence),
    run: <Value, Error>(effect: Effect.Effect<Value, Error>) => Effect.runPromise(effect),
    pruneReceipts: () => persistence.clearReceipts(),
  }
}

storeConformance('Memory store', () => ({
  store: Memory.store({ encryptor }),
  run: <Value, Error>(effect: Effect.Effect<Value, Error>) => Effect.runPromise(effect),
}))
credentialOperationStoreConformance('Memory store', makeTarget)

test('Memory store: direct encryption key protects and unprotects credentials', async () => {
  const store = Memory.store({ encryptionKey: 'KioqKioqKioqKioqKioqKioqKioqKioqKioqKioqKio=' })
  const context = {
    namespace: 'direct-key',
    providerId: 'salesforce',
    connectionId: 'connection',
    generation: 0,
    purpose: 'credentials' as const,
  }
  const plaintext = 'direct-key-memory-credential'
  const envelope = await Effect.runPromise(store.protect(Redacted.make(plaintext), context))

  expect(envelope.algorithm).toBe('AES-256-GCM')
  expect(JSON.stringify(envelope)).not.toContain(plaintext)
  await expect(
    Effect.runPromise(store.unprotect(envelope, context)).then(Redacted.value),
  ).resolves.toBe(plaintext)
})

test('Memory store: invalid direct encryption key fails without exposing key material', async () => {
  const invalidKey = 'not-a-valid-aes-key'
  const store = Memory.store({ encryptionKey: invalidKey })
  const failure = await Effect.runPromise(
    Effect.flip(
      store.protect(Redacted.make('credential'), {
        namespace: 'direct-key',
        providerId: 'salesforce',
        connectionId: 'connection',
        generation: 0,
        purpose: 'credentials',
      }),
    ),
  )

  expect(failure).toBeInstanceOf(EncryptionFailure)
  expect(failure.reason).toBe('InvalidKey')
  expect(JSON.stringify(failure)).not.toContain(invalidKey)
})

test('Memory store: separate store objects do not share state', async () => {
  const first = Memory.store({ encryptor })
  const second = Memory.store({ encryptor })
  const key = {
    namespace: 'memory-isolation',
    providerId: 'salesforce',
    connectionId: 'connection',
  }
  const input = { _tag: 'InitializeConnection' as const, key }
  await Effect.runPromise(
    first.execute({
      ...input,
      request: { requestId: 'initialize', inputDigest: await digestStoreInput(input) },
    }),
  )

  await expect(Effect.runPromise(first.readConnection(key))).resolves.not.toBeNull()
  await expect(Effect.runPromise(second.readConnection(key))).resolves.toBeNull()
})
