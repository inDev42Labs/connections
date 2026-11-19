import { Buffer } from 'node:buffer'
import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Effect, Exit, Redacted } from 'effect'
import { afterEach, expect, onTestFinished, test, vi } from 'vitest'
import { Connections, revealSecret } from '../../src/index.js'
import { Shopify } from '../../src/providers/shopify/index.js'
import { SQLite } from '../../src/stores/sqlite/index.js'
import {
  makeLifecycleDriver,
  makeTestClock,
  waitForLifecycle as eventually,
} from '../fixtures/lifecycle-driver.js'

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
type TestFetch = (url: string | URL | Request, init?: RequestInit) => Promise<Response>

async function fixture(configuredProvider = provider(), decryptionDelay = 0) {
  const directory = mkdtempSync(join(tmpdir(), 'shopify-recovery-'))
  const path = join(directory, 'connections.sqlite')
  let database = new DatabaseSync(path)
  const clock = makeTestClock(1_000)
  const driver = makeLifecycleDriver(clock.layer)
  let cleanup: Promise<void> | undefined
  const dispose = () =>
    (cleanup ??= (async () => {
      await driver.dispose()
      if (database.isOpen) database.close()
      rmSync(directory, { recursive: true, force: true })
    })())
  onTestFinished(dispose)
  await driver.run(clock.initialize)
  let ready = false
  const decryptionReached = Promise.withResolvers<void>()
  const manager = () => {
    const store = SQLite.store({ database, encryptionKey })
    return Connections.create({
      store: {
        ...store,
        unprotect: (...args: Parameters<typeof store.unprotect>) =>
          Effect.suspend(() => {
            if (!ready) return store.unprotect(...args)
            decryptionReached.resolve()
            return decryptionDelay === 0
              ? store.unprotect(...args)
              : Effect.sleep(decryptionDelay).pipe(Effect.andThen(store.unprotect(...args)))
          }),
      },
      provider: configuredProvider,
    })
  }
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
  ready = true
  return {
    clock,
    driver,
    manager,
    decryptionReached: decryptionReached.promise,
    reopen: () => {
      database.close()
      database = new DatabaseSync(path)
    },
    dispose,
  }
}

afterEach(() => vi.unstubAllGlobals())

test('Shopify waits 250ms and 750ms between at most three refresh attempts', async () => {
  const fetch = vi
    .fn<TestFetch>()
    .mockResolvedValueOnce(Response.json(tokenBody('initial')))
    .mockRejectedValueOnce(new TypeError('lost response'))
    .mockResolvedValueOnce(new Response(null, { status: 503 }))
    .mockResolvedValueOnce(Response.json(tokenBody('recovered')))
  vi.stubGlobal('fetch', fetch)
  const target = await fixture()
  const run = target.driver.start(target.manager().effect.credentials('shop'))
  try {
    await eventually(() => fetch.mock.calls.length === 2)
    await target.driver.run(target.clock.advanceBy(249))
    expect(fetch).toHaveBeenCalledTimes(2)
    await target.driver.run(target.clock.advanceBy(1))
    await eventually(() => fetch.mock.calls.length === 3)
    await target.driver.run(target.clock.advanceBy(749))
    expect(fetch).toHaveBeenCalledTimes(3)
    await target.driver.run(target.clock.advanceBy(1))
    const exit = await run.exit
    if (!Exit.isSuccess(exit)) throw new Error('Expected recovered credential read')
    expect(revealSecret(exit.value.accessToken)).toBe('recovered')
    expect(fetch).toHaveBeenCalledTimes(4)
  } finally {
    run.interrupt()
    await run.exit
    await target.dispose()
  }
})

test.each([0, 24_700])(
  'Shopify shortens the HTTP budget after storage consumes %s ms of renewal ownership',
  async (decryptionDelay) => {
    let signal: AbortSignal | undefined
    const fetch = vi
      .fn<TestFetch>()
      .mockResolvedValueOnce(Response.json(tokenBody('initial')))
      .mockImplementation(
        async (_url, init) =>
          new Promise<Response>((_resolve, reject) => {
            if (init?.signal == null) throw new Error('Expected abort signal')
            signal = init.signal
            signal.addEventListener('abort', () => reject(new TypeError('aborted')), { once: true })
          }),
      )
    vi.stubGlobal('fetch', fetch)
    const target = await fixture(provider(), decryptionDelay)
    const run = target.driver.start(Effect.flip(target.manager().effect.credentials('shop')))
    try {
      await target.decryptionReached
      await target.driver.run(target.clock.advanceBy(decryptionDelay))
      await eventually(() => fetch.mock.calls.length === 2)
      await target.driver.run(target.clock.advanceBy(25_000 - decryptionDelay - 1))
      expect(signal?.aborted).toBe(false)
      await target.driver.run(target.clock.advanceBy(1))
      expect(signal?.aborted).toBe(true)
      expect(await run.exit).toMatchObject({ value: { _tag: 'TemporarilyUnavailable' } })
      expect(fetch).toHaveBeenCalledTimes(2)
      await expect(target.driver.run(target.manager().effect.inspect('shop'))).resolves.toEqual({
        savedAuthorization: true,
        credentialWork: 'known-failure',
      })
    } finally {
      run.interrupt()
      await run.exit
      await target.dispose()
    }
  },
)

test.each(['5', 'Thu, 01 Jan 1970 00:00:06 GMT'])(
  'Shopify honors a retained Retry-After before acquiring again: %s',
  async (retryAfter) => {
    let healthy = false
    const fetch = vi
      .fn<TestFetch>()
      .mockResolvedValueOnce(Response.json(tokenBody('initial')))
      .mockImplementation(async () =>
        healthy
          ? Response.json(tokenBody('recovered'))
          : new Response(null, { status: 429, headers: { 'retry-after': retryAfter } }),
      )
    vi.stubGlobal('fetch', fetch)
    const target = await fixture()
    try {
      await expect(
        target.driver.run(target.manager().effect.credentials('shop')),
      ).rejects.toMatchObject({
        _tag: 'TemporarilyUnavailable',
      })
      expect(fetch).toHaveBeenCalledTimes(2)
      expect(await target.driver.run(target.clock.now)).toBe(1_000)
      healthy = true
      await target.driver.run(target.clock.advanceBy(4_999))
      await expect(
        target.driver.run(target.manager().effect.credentials('shop')),
      ).rejects.toMatchObject({
        _tag: 'TemporarilyUnavailable',
      })
      expect(fetch).toHaveBeenCalledTimes(2)
      await target.driver.run(target.clock.advanceBy(1))
      const credentials = await target.driver.run(target.manager().effect.credentials('shop'))
      expect(revealSecret(credentials.accessToken)).toBe('recovered')
      expect(fetch).toHaveBeenCalledTimes(3)
    } finally {
      await target.dispose()
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
