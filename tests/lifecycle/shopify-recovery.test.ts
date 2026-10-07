import { Buffer } from 'node:buffer'
import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Effect, Exit, Redacted } from 'effect'
import { afterEach, expect, test, vi } from 'vitest'
import { Connections, revealSecret } from '../../src/index.js'
import { Shopify } from '../../src/providers/shopify/index.js'
import { SQLite } from '../../src/stores/sqlite/index.js'
import { makeLifecycleDriver, makeTestClock } from '../fixtures/lifecycle-driver.js'

const shopDomain = 'recovery-test.myshopify.com'
const redirectUri = 'https://app.example.test/shopify/callback'
const secret = 'client-secret'
const encryptionKey = Buffer.alloc(32, 81).toString('base64')
const provider = () =>
  Shopify.oauth({
    clientId: 'client-id',
    clientSecret: secret,
    redirectUri,
    shopDomain,
    scopes: ['read_products'],
  })
const tokenBody = (accessToken = 'access-token') => ({
  access_token: accessToken,
  refresh_token: `${accessToken}-refresh`,
  expires_in: 3600,
  refresh_token_expires_in: 7_776_000,
  scope: 'read_products',
})
const payload = Redacted.make(
  JSON.stringify({
    schemaVersion: 1,
    accessToken: 'old-access',
    refreshToken: 'old-refresh',
    shopDomain,
    credentialExpiresAt: 1,
    refreshTokenExpiresAt: 7_776_001_000,
  }),
)
type TestFetch = (url: string | URL | Request, init?: RequestInit) => Promise<Response>

async function eventually(check: () => boolean) {
  for (let i = 0; i < 100; i++) {
    if (check()) return
    await new Promise<void>((resolve) => setImmediate(resolve))
  }
  throw new Error('Lifecycle did not reach expected checkpoint')
}

async function fixture(configuredProvider = provider()) {
  const directory = mkdtempSync(join(tmpdir(), 'shopify-recovery-'))
  const path = join(directory, 'connections.sqlite')
  let database = new DatabaseSync(path)
  const clock = makeTestClock(1_000)
  const driver = makeLifecycleDriver(clock.layer)
  await driver.run(clock.initialize)
  const manager = () =>
    Connections.create({
      store: SQLite.store({ database, encryptionKey }),
      provider: configuredProvider,
    })
  const initial = manager()
  const start = await driver.run(
    initial.effect.startAuthorization('shop', { binding: 'trusted-session' }),
  )
  const state = new URL(start.url).searchParams.get('state')
  if (state === null) throw new Error('Expected OAuth state')
  const callback = new URL(redirectUri)
  callback.search = new URLSearchParams({
    code: 'initial-code',
    state,
    shop: shopDomain,
  }).toString()
  const parameters = [...callback.searchParams.entries()].sort(([a], [b]) =>
    a < b ? -1 : a > b ? 1 : 0,
  )
  const encoder = new TextEncoder()
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  const signature = await crypto.subtle.sign(
    'HMAC',
    key,
    encoder.encode(parameters.map(([name, value]) => `${name}=${value}`).join('&')),
  )
  callback.searchParams.set('hmac', Buffer.from(signature).toString('hex'))
  await driver.run(
    initial.effect.completeAuthorization({
      callbackUrl: callback.toString(),
      binding: 'trusted-session',
      authorize: async () => undefined,
    }),
  )
  await driver.run((await driver.run(initial.effect.credentialUse('shop'))).reportRejected())
  return {
    clock,
    driver,
    manager,
    reopen: () => {
      database.close()
      database = new DatabaseSync(path)
    },
    dispose: async () => {
      await driver.dispose()
      database.close()
      rmSync(directory, { recursive: true, force: true })
    },
  }
}

afterEach(() => vi.unstubAllGlobals())

test('Shopify waits 250ms and 750ms between at most three refresh attempts', async () => {
  const clock = makeTestClock(1_000)
  const driver = makeLifecycleDriver(clock.layer)
  await driver.run(clock.initialize)
  const fetch = vi
    .fn<TestFetch>()
    .mockRejectedValueOnce(new TypeError('lost response'))
    .mockResolvedValueOnce(new Response(null, { status: 503 }))
    .mockResolvedValueOnce(Response.json(tokenBody('recovered')))
  vi.stubGlobal('fetch', fetch)
  const run = driver.start(provider().refreshCredentials({ protectedPayload: payload, now: 1_000 }))
  try {
    await eventually(() => fetch.mock.calls.length === 1)
    await driver.run(clock.advanceBy(249))
    expect(fetch).toHaveBeenCalledTimes(1)
    await driver.run(clock.advanceBy(1))
    await eventually(() => fetch.mock.calls.length === 2)
    await driver.run(clock.advanceBy(749))
    expect(fetch).toHaveBeenCalledTimes(2)
    await driver.run(clock.advanceBy(1))
    const exit = await run.exit
    expect(exit).toMatchObject({ value: { _tag: 'Refreshed' } })
    expect(fetch).toHaveBeenCalledTimes(3)
  } finally {
    run.interrupt()
    await run.exit
    await driver.dispose()
  }
})

test.each([undefined, 1_300])(
  'Shopify aborts a stalled request at the shared deadline, deadline: %s',
  async (deadline) => {
    const clock = makeTestClock(1_000)
    const driver = makeLifecycleDriver(clock.layer)
    await driver.run(clock.initialize)
    let signal: AbortSignal | undefined
    const fetch = vi.fn<TestFetch>(
      async (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          if (init?.signal == null) throw new Error('Expected abort signal')
          signal = init.signal
          signal.addEventListener('abort', () => reject(new TypeError('aborted')), { once: true })
        }),
    )
    vi.stubGlobal('fetch', fetch)
    const budget = deadline === undefined ? 25_000 : 300
    const run = driver.start(
      provider().refreshCredentials({
        protectedPayload: payload,
        now: 1_000,
        ...(deadline === undefined ? {} : { deadline }),
      }),
    )
    try {
      await eventually(() => fetch.mock.calls.length === 1)
      await driver.run(clock.advanceBy(budget - 1))
      expect(signal?.aborted).toBe(false)
      await driver.run(clock.advanceBy(1))
      expect(await run.exit).toMatchObject({
        value: {
          _tag: 'ProviderFailure',
          recovery: { _tag: 'ReplaySafe', retryUntil: 2_592_001_000 },
        },
      })
      expect(signal?.aborted).toBe(true)
      expect(fetch).toHaveBeenCalledTimes(1)
    } finally {
      run.interrupt()
      await run.exit
      await driver.dispose()
    }
  },
)

test.each(['5', 'Thu, 01 Jan 1970 00:00:06 GMT'])(
  'Shopify persists Retry-After instead of sleeping beyond its backoff allowance: %s',
  async (retryAfter) => {
    const clock = makeTestClock(1_000)
    const driver = makeLifecycleDriver(clock.layer)
    await driver.run(clock.initialize)
    const fetch = vi.fn<TestFetch>(
      async () => new Response(null, { status: 429, headers: { 'retry-after': retryAfter } }),
    )
    vi.stubGlobal('fetch', fetch)
    try {
      expect(
        await driver.run(provider().refreshCredentials({ protectedPayload: payload, now: 1_000 })),
      ).toEqual({
        _tag: 'ProviderFailure',
        recovery: { _tag: 'ReplaySafe', retryUntil: 2_592_001_000, retryAt: 6_000 },
      })
      expect(fetch).toHaveBeenCalledTimes(1)
      expect(await driver.run(clock.now)).toBe(1_000)
    } finally {
      await driver.dispose()
    }
  },
)

test('the public manager budgets configuration and HTTP together and records failure before ownership expires', async () => {
  let delayConfiguration = false
  let configurationReached = false
  let signal: AbortSignal | undefined
  const configured = Shopify.oauth({
    clientId: 'client-id',
    redirectUri,
    shopDomain,
    scopes: ['read_products'],
    clientSecret: Effect.suspend(() => {
      if (!delayConfiguration) return Effect.succeed(Redacted.make(secret))
      configurationReached = true
      return Effect.sleep(20_000).pipe(Effect.as(Redacted.make(secret)))
    }),
  })
  const fetch = vi.fn<TestFetch>(async (_url, init) => {
    if (!(init?.body instanceof URLSearchParams)) throw new Error('Expected token parameters')
    if (init.body.has('code')) return Response.json(tokenBody('initial'))
    return new Promise<Response>((_resolve, reject) => {
      if (init.signal == null) throw new Error('Expected abort signal')
      signal = init.signal
      signal.addEventListener('abort', () => reject(new TypeError('aborted')), { once: true })
    })
  })
  vi.stubGlobal('fetch', fetch)
  const target = await fixture(configured)
  delayConfiguration = true
  const owner = target.driver.start(Effect.flip(target.manager().effect.credentials('shop')))
  try {
    await eventually(() => configurationReached)
    await target.driver.run(target.clock.advanceBy(20_000))
    await eventually(() => fetch.mock.calls.length === 2)
    await target.driver.run(target.clock.advanceBy(4_999))
    expect(signal?.aborted).toBe(false)
    await target.driver.run(target.clock.advanceBy(1))
    expect(await owner.exit).toMatchObject({ value: { _tag: 'TemporarilyUnavailable' } })
    expect(signal?.aborted).toBe(true)
    expect(await target.driver.run(target.clock.now)).toBe(26_000)
    await expect(target.driver.run(target.manager().effect.inspect('shop'))).resolves.toEqual({
      savedAuthorization: true,
      credentialWork: 'known-failure',
    })
  } finally {
    owner.interrupt()
    await owner.exit
    await target.dispose()
  }
})

test('retained Shopify replay evidence survives reopening SQLite, honors Retry-After, and fences concurrent readers', async () => {
  let requests = 0
  let healthy = false
  const reached = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  const fetch = vi.fn<TestFetch>(async (_url, init) => {
    requests++
    if (!(init?.body instanceof URLSearchParams)) throw new Error('Expected token parameters')
    if (init.body.has('code')) return Response.json(tokenBody('initial'))
    if (!healthy) return new Response(null, { status: 429, headers: { 'retry-after': '5' } })
    reached.resolve()
    await release.promise
    return Response.json(tokenBody('recovered'))
  })
  vi.stubGlobal('fetch', fetch)
  const target = await fixture()
  try {
    await expect(
      target.driver.run(Effect.flip(target.manager().effect.credentials('shop'))),
    ).resolves.toMatchObject({ _tag: 'TemporarilyUnavailable' })
    expect(requests).toBe(2)
    target.reopen()
    healthy = true
    await expect(
      target.driver.run(Effect.flip(target.manager().effect.credentials('shop'))),
    ).resolves.toMatchObject({ _tag: 'TemporarilyUnavailable' })
    expect(requests).toBe(2)
    await target.driver.run(target.clock.advanceBy(5_000))
    const owner = target.driver.start(target.manager().effect.credentials('shop'))
    await reached.promise
    const follower = target.driver.start(target.manager().effect.credentials('shop'))
    release.resolve()
    const exit = await owner.exit
    if (Exit.isFailure(exit)) throw new Error('Recovery failed')
    expect(revealSecret(exit.value.accessToken)).toBe('recovered')
    await target.driver.run(target.clock.advanceBy(25))
    expect(await follower.exit).toMatchObject({ value: { shopDomain } })
    expect(requests).toBe(3)
    await expect(target.driver.run(target.manager().effect.inspect('shop'))).resolves.toEqual({
      savedAuthorization: true,
      credentialWork: 'idle',
    })
  } finally {
    release.resolve()
    await target.dispose()
  }
})

test('an abandoned first Shopify dispatch without retained replay evidence is not guessed safe', async () => {
  const reached = Promise.withResolvers<void>()
  const fetch = vi.fn<TestFetch>(async (_url, init) => {
    if (!(init?.body instanceof URLSearchParams)) throw new Error('Expected token parameters')
    if (init.body.has('code')) return Response.json(tokenBody('initial'))
    reached.resolve()
    return new Promise<Response>((_resolve, reject) => {
      if (init.signal == null) throw new Error('Expected abort signal')
      init.signal.addEventListener('abort', () => reject(new TypeError('aborted')), { once: true })
    })
  })
  vi.stubGlobal('fetch', fetch)
  const target = await fixture()
  const owner = target.driver.start(target.manager().effect.credentials('shop'))
  try {
    await reached.promise
    owner.interrupt()
    await owner.exit
    target.reopen()
    await target.driver.run(target.clock.advanceBy(30_000))
    await expect(
      target.driver.run(Effect.flip(target.manager().effect.credentials('shop'))),
    ).resolves.toMatchObject({ _tag: 'InterventionRequired' })
    expect(fetch).toHaveBeenCalledTimes(2)
  } finally {
    owner.interrupt()
    await owner.exit
    await target.dispose()
  }
})

test('confirmed Shopify rejection stays AuthorizationRequired after an earlier replay window expires', async () => {
  let refreshes = 0
  const fetch = vi.fn<TestFetch>(async (_url, init) => {
    if (!(init?.body instanceof URLSearchParams)) throw new Error('Expected token parameters')
    if (init.body.has('code')) return Response.json(tokenBody('initial'))
    refreshes++
    return new Response(
      null,
      refreshes === 1 ? { status: 429, headers: { 'retry-after': '5' } } : { status: 401 },
    )
  })
  vi.stubGlobal('fetch', fetch)
  const target = await fixture()
  try {
    await expect(
      target.driver.run(Effect.flip(target.manager().effect.credentials('shop'))),
    ).resolves.toMatchObject({ _tag: 'TemporarilyUnavailable' })
    await target.driver.run(target.clock.advanceBy(5_000))
    await expect(
      target.driver.run(Effect.flip(target.manager().effect.credentials('shop'))),
    ).resolves.toMatchObject({ _tag: 'AuthorizationRequired' })
    target.reopen()
    await target.driver.run(target.clock.advanceBy(2_592_000_000))
    await expect(
      target.driver.run(Effect.flip(target.manager().effect.credentials('shop'))),
    ).resolves.toMatchObject({ _tag: 'AuthorizationRequired' })
    expect(fetch).toHaveBeenCalledTimes(3)
  } finally {
    await target.dispose()
  }
})

test('later Shopify failure does not extend the original replay window; expiry requires intervention without dispatch', async () => {
  const fetch = vi.fn<TestFetch>(async (_url, init) => {
    if (!(init?.body instanceof URLSearchParams)) throw new Error('Expected token parameters')
    return init.body.has('code')
      ? Response.json(tokenBody('initial'))
      : new Response(null, { status: 429, headers: { 'retry-after': '5' } })
  })
  vi.stubGlobal('fetch', fetch)
  const target = await fixture()
  try {
    await expect(
      target.driver.run(Effect.flip(target.manager().effect.credentials('shop'))),
    ).resolves.toMatchObject({ _tag: 'TemporarilyUnavailable' })
    await target.driver.run(target.clock.advanceBy(5_000))
    await expect(
      target.driver.run(Effect.flip(target.manager().effect.credentials('shop'))),
    ).resolves.toMatchObject({ _tag: 'TemporarilyUnavailable' })
    expect(fetch).toHaveBeenCalledTimes(3)
    target.reopen()
    await target.driver.run(target.clock.advanceBy(2_592_000_000 - 5_000))
    await expect(
      target.driver.run(Effect.flip(target.manager().effect.credentials('shop'))),
    ).resolves.toMatchObject({
      _tag: 'InterventionRequired',
      cause: { _tag: 'ProviderOutcomeUnknown' },
    })
    expect(fetch).toHaveBeenCalledTimes(3)
    await expect(target.driver.run(target.manager().effect.inspect('shop'))).resolves.toEqual({
      savedAuthorization: true,
      credentialWork: 'intervention-required',
    })
  } finally {
    await target.dispose()
  }
})
