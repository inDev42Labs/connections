import { Buffer } from 'node:buffer'
import { Effect, Redacted } from 'effect'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { Connections } from '../../../src/index.js'
import { AesGcm } from '../../../src/encryptors/aes-gcm/index.js'
import { ApiKey } from '../../../src/providers/api-key/index.js'
import { makeInMemoryStore } from '../../fixtures/in-memory-store.js'

function value(redacted: Redacted.Redacted<string>): string {
  return Redacted.value(redacted)
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('opaque API-key provider', () => {
  test('round-trips an opaque key without adding service metadata or making traffic', async () => {
    const fetch = vi.fn<() => void>()
    vi.stubGlobal('fetch', fetch)
    const provider = ApiKey.opaque({ id: 'retell' })
    const opaque = '  opaque.service/key+value  '

    const prepared = await Effect.runPromise(provider.prepareApiKey(Redacted.make(opaque)))
    const credentials = await Effect.runPromise(
      provider.projectCredentials(prepared.protectedPayload),
    )

    expect(provider.id).toBe('retell')
    expect(prepared.credentialExpiresAt).toBeNull()
    expect(value(credentials.apiKey)).toBe(opaque)
    expect(Object.keys(credentials)).toEqual(['apiKey'])
    expect(fetch).not.toHaveBeenCalled()
  })

  test('uses the static lifecycle without provider traffic', async () => {
    const fetch = vi.fn<() => void>()
    vi.stubGlobal('fetch', fetch)
    const store = makeInMemoryStore({
      encryptor: AesGcm.encryptor({
        key: Effect.succeed(
          Redacted.make(Buffer.from(new Uint8Array(32).fill(17)).toString('base64')),
        ),
        keyId: 'api-key-test',
      }),
    })
    const connection = Connections.create({
      provider: ApiKey.opaque({ id: 'retell' }),
      store,
    }).effect

    await Effect.runPromise(
      connection.setApiKey('integration_acme', 'retell-key', { replace: false }),
    )
    const credentials = await Effect.runPromise(connection.credentialUse('integration_acme'))

    expect(value(credentials.credentials.apiKey)).toBe('retell-key')
    expect(store.diagnostics.commands.SaveCredential).toBe(1)
    expect(fetch).not.toHaveBeenCalled()
  })

  test('rejects empty ids, empty keys, and malformed payloads without echoing secrets', async () => {
    const secret = '__malformed_api_key_secret__'
    expect(() => ApiKey.opaque({ id: '' })).toThrow('must not be empty')
    const provider = ApiKey.opaque({ id: 'service' })

    const emptyFailure = await Effect.runPromise(
      Effect.flip(provider.prepareApiKey(Redacted.make(''))),
    )
    const malformedFailure = await Effect.runPromise(
      Effect.flip(
        provider.projectCredentials(
          Redacted.make(JSON.stringify({ schemaVersion: 2, apiKey: secret })),
        ),
      ),
    )

    expect(String(emptyFailure)).not.toContain(secret)
    expect(String(malformedFailure)).not.toContain(secret)
    expect(JSON.stringify(malformedFailure)).not.toContain(secret)
  })
})
