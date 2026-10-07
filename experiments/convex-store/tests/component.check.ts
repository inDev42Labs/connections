import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { convexTest } from 'convex-test'
import { Effect, Redacted, Result } from 'effect'
import appSchema from '../src/convex/schema'
import componentSchema from '../src/component/schema'
import { api, components } from '../src/convex/_generated/api'
import { AesGcm } from '../src/adapter'

const appModules = import.meta.glob(['../src/convex/**/*.{ts,js}', '!../src/convex/**/*.d.ts'])
const componentModules = import.meta.glob('../src/component/**/*.ts')
const key = btoa(String.fromCharCode(...new Uint8Array(32).fill(42))) // FAKE ONLY.
const opaque = { iv: new Uint8Array(12).buffer, ciphertext: new Uint8Array([1, 2, 3]).buffer, format: 'aes-gcm-v1' as const }
const initialize = () => {
  const t = convexTest(appSchema, appModules)
  t.registerComponent('credentialStore', componentSchema, componentModules)
  return t
}

beforeEach(() => {
  vi.stubEnv('CONVEX_CLOUD_URL', 'http://127.0.0.1:33210')
  vi.stubEnv('CONVEX_SITE_URL', 'http://127.0.0.1:33211')
  vi.stubEnv('CONNECTIONS_TEST_KEY', key)
})
afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
})

describe('component storage contracts (mock backend)', () => {
  test('one claimant wins; completion replay is idempotent; stale ownership cannot write or renew', async () => {
    const t = initialize()
    const refs = components.credentialStore.records
    await t.mutation(refs.initialize, { key: 'claim', envelope: opaque, expiresAt: 0 })
    const claims = await Promise.all(Array.from({ length: 8 }, (_, i) =>
      t.mutation(refs.claim, { key: 'claim', expectedVersion: 0, owner: `worker-${i}`, leaseMs: 5_000 }),
    ))
    expect(claims.filter((claim) => claim.claimed)).toHaveLength(1)
    const index = claims.findIndex((claim) => claim.claimed)
    const claim = claims[index]
    if (!claim.claimed) throw new Error('Expected claimed record')
    const completion = { key: 'claim', owner: `worker-${index}`, fence: claim.fence, writeId: 'write-1', envelope: opaque, expiresAt: 0 }
    expect(await t.mutation(refs.complete, completion)).toEqual({ status: 'committed', version: 2 })
    expect(await t.mutation(refs.complete, completion)).toEqual({ status: 'already-applied', version: 2 })
    const next = await t.mutation(refs.claim, { key: 'claim', expectedVersion: 2, owner: 'new-owner', leaseMs: 5_000 })
    expect(next.claimed).toBe(true)
    expect((await t.mutation(refs.complete, { ...completion, writeId: 'stale-write' })).status).toBe('conflict')
    // Recognizing the old completion must not clear the newer claim.
    expect((await t.mutation(refs.complete, completion)).status).toBe('already-applied')
    expect((await t.query(refs.read, { key: 'claim' }))?.owner).toBe('new-owner')
    expect(await t.mutation(refs.renew, { key: 'claim', owner: completion.owner, fence: claim.fence, leaseMs: 5_000 })).toBe(false)
  })

  test('expired leases cannot revive; transfer changes the fence and rejects late completion', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000)
    const t = initialize()
    const refs = components.credentialStore.records
    await t.mutation(refs.initialize, { key: 'expired', envelope: opaque, expiresAt: 0 })
    const first = await t.mutation(refs.claim, { key: 'expired', expectedVersion: 0, owner: 'old', leaseMs: 50 })
    if (!first.claimed) throw new Error('Expected claim')
    vi.setSystemTime(1_100)
    expect(await t.mutation(refs.renew, { key: 'expired', owner: 'old', fence: first.fence, leaseMs: 50 })).toBe(false)
    const next = await t.mutation(refs.claim, { key: 'expired', expectedVersion: 1, owner: 'new', leaseMs: 50 })
    if (!next.claimed) throw new Error('Expected transferred storage ownership')
    expect(next.fence).toBeGreaterThan(first.fence)
    expect((await t.mutation(refs.complete, { key: 'expired', owner: 'old', fence: first.fence, writeId: 'late', envelope: opaque, expiresAt: 0 })).status).toBe('conflict')
    await expect(t.mutation(refs.claim, { key: 'expired', expectedVersion: next.version, owner: 'invalid', leaseMs: 0 })).rejects.toThrow()
  })

  test('authorization attempts require matching binding, expiry, and single-use consumption', async () => {
    const t = initialize()
    const refs = components.credentialStore.attempts
    await t.mutation(refs.save, { id: 'attempt', envelope: opaque, binding: 'session-A', expiresAt: Date.now() + 60_000 })
    expect(await t.mutation(refs.consume, { id: 'attempt', binding: 'session-B' })).toBeNull()
    const consumed = await Promise.all([
      t.mutation(refs.consume, { id: 'attempt', binding: 'session-A' }),
      t.mutation(refs.consume, { id: 'attempt', binding: 'session-A' }),
    ])
    expect(consumed.filter((value) => value !== null)).toHaveLength(1)
    await t.mutation(refs.save, { id: 'expired', envelope: opaque, binding: 'session-A', expiresAt: 0 })
    expect(await t.mutation(refs.consume, { id: 'expired', binding: 'session-A' })).toBeNull()
  })
})

describe('app-side Effect and encryption', () => {
  test('encrypted storage round trip; wrong keys, tampering, and swapped context fail', async () => {
    const t = initialize()
    await t.action(api.actions.seed, { id: 'cipher' })
    const storageKey = JSON.stringify(['fake-salesforce', 'cipher'])
    const row = await t.query(components.credentialStore.records.read, { key: storageKey })
    if (row === null) throw new Error('Missing fixture')
    expect(row.envelope.iv.byteLength).toBe(12)
    expect(new TextDecoder().decode(row.envelope.ciphertext)).not.toContain('FAKE-refresh')
    const cipher = AesGcm.make(() => key)
    const decoded = await Effect.runPromise(cipher.decrypt(storageKey, row.expiresAt, row.envelope))
    expect(Redacted.value(decoded.refreshToken)).toBe('FAKE-refresh-0')
    const wrong = AesGcm.make(() => btoa(String.fromCharCode(...new Uint8Array(32).fill(43))))
    const tampered = new Uint8Array(row.envelope.ciphertext.slice(0))
    tampered[0] ^= 1
    for (const effect of [
      wrong.decrypt(storageKey, row.expiresAt, row.envelope),
      cipher.decrypt('different-connection', row.expiresAt, row.envelope),
      cipher.decrypt(storageKey, row.expiresAt + 1, row.envelope),
      cipher.decrypt(storageKey, row.expiresAt, { ...row.envelope, ciphertext: tampered.buffer }),
    ]) {
      const result = await Effect.runPromise(Effect.result(effect))
      expect(Result.isFailure(result)).toBe(true)
    }
  })

  test('action-scoped workflow crosses component and mocked HTTP, refreshes once, and returns no secrets', async () => {
    const t = initialize()
    vi.stubGlobal('fetch', async (input: string | URL, init?: RequestInit) => {
      const url = new URL(input)
      expect(init?.redirect).toBe('error')
      if (url.origin !== 'http://127.0.0.1:33211') throw new Error('Unexpected network request')
      return t.fetch(url.pathname, init)
    })
    await t.action(api.actions.seed, { id: 'workflow' })
    const results = await Promise.all(Array.from({ length: 4 }, () => t.action(api.actions.credentialsProbe, { id: 'workflow' })))
    expect(results).toEqual(Array.from({ length: 4 }, () => ({ usable: true, redacted: true })))
    expect(await t.query(components.credentialStore.records.providerCalls, { key: JSON.stringify(['fake-salesforce', 'workflow']) })).toBe(1)
    expect(await t.query(components.credentialStore.records.providerRequests, { key: JSON.stringify(['fake-salesforce', 'workflow']) })).toBe(1)
    expect(await t.action(api.actions.runtimeProbe, {})).toEqual({ timer: true, interrupted: true, finalized: true, childFinalized: true })
  })
})
