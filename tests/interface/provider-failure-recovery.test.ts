import { Buffer } from 'node:buffer'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { Connections, revealSecret } from '../../src/index.js'
import { Salesforce } from '../../src/providers/salesforce/index.js'
import { Shopify } from '../../src/providers/shopify/index.js'
import { Zoho } from '../../src/providers/zoho/index.js'
import { Memory } from '../../src/stores/memory/index.js'
import { SQLite } from '../../src/stores/sqlite/index.js'

const encryptionKey = Buffer.alloc(32, 81).toString('base64')
const redirectUri = 'https://app.example.test/oauth/callback'
const shopDomain = 'recovery-test.myshopify.com'
const binding = 'trusted-session'
const connectionId = 'recoverable-connection'
const clientSecret = 'client-secret'
type ProviderKind = 'salesforce' | 'zoho' | 'shopify'

function provider(kind: ProviderKind, secret: () => string) {
  switch (kind) {
    case 'salesforce':
      return Salesforce.oauth({
        clientId: 'client-id',
        clientSecret: secret,
        redirectUri,
        scopes: ['api', 'refresh_token'],
      })
    case 'zoho':
      return Zoho.oauth({
        clientId: 'client-id',
        clientSecret: secret,
        redirectUri,
        scopes: ['ZohoCRM.modules.ALL'],
        accountsOrigin: 'https://accounts.zoho.example',
      })
    case 'shopify':
      return Shopify.oauth({
        clientId: 'client-id',
        clientSecret: secret,
        redirectUri,
        scopes: ['read_products'],
        shopDomain,
      })
  }
}

function tokenResponse(kind: ProviderKind, token: string): Response {
  const common = { access_token: token, refresh_token: `${token}-refresh`, expires_in: 3600 }
  switch (kind) {
    case 'salesforce':
      return Response.json({
        ...common,
        instance_url: 'https://instance.example.test',
        token_type: 'Bearer',
      })
    case 'zoho':
      return Response.json({
        ...common,
        api_domain: 'https://www.zohoapis.example',
        token_type: 'Bearer',
      })
    case 'shopify':
      return Response.json({
        ...common,
        scope: 'read_products',
        refresh_token_expires_in: 7_776_000,
      })
  }
}

async function callbackUrl(kind: ProviderKind, authorizationUrl: string): Promise<string> {
  const state = new URL(authorizationUrl).searchParams.get('state')
  if (state === null) throw new Error('Expected OAuth state')
  const callback = new URL(redirectUri)
  callback.search = new URLSearchParams({ code: 'initial-code', state }).toString()
  if (kind === 'shopify') {
    callback.searchParams.set('shop', shopDomain)
    const parameters = [...callback.searchParams.entries()]
    parameters.sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    const message = parameters.map(([key, value]) => `${key}=${value}`).join('&')
    const encoder = new TextEncoder()
    const key = await crypto.subtle.importKey(
      'raw',
      encoder.encode(clientSecret),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign'],
    )
    const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(message))
    callback.searchParams.set('hmac', Buffer.from(signature).toString('hex'))
  }
  return callback.toString()
}

function fixture(kind: ProviderKind, storeKind: 'memory' | 'sqlite') {
  let configurationAvailable = true
  const secret = () => {
    if (!configurationAvailable) throw new Error('Configuration unavailable')
    return clientSecret
  }
  const database = storeKind === 'sqlite' ? new DatabaseSync(':memory:') : undefined
  const store =
    database === undefined
      ? Memory.store({ encryptionKey })
      : SQLite.store({ database, encryptionKey })
  const configuredProvider = provider(kind, secret)
  const makeManager = () => Connections.create({ store, provider: configuredProvider })
  const manager = makeManager()
  return {
    manager,
    makeManager,
    setConfigurationAvailable: (available: boolean) => {
      configurationAvailable = available
    },
    close: () => database?.close(),
    enroll: async () => {
      const start = await manager.startAuthorization(connectionId, { binding })
      await manager.completeAuthorization({
        callbackUrl: await callbackUrl(kind, start.url),
        binding,
        authorize: async () => undefined,
      })
      await (await manager.credentialUse(connectionId)).reportRejected()
    },
  }
}

afterEach(() => vi.unstubAllGlobals())

describe('public-manager recovery from retained provider failures', () => {
  for (const kind of ['salesforce', 'zoho', 'shopify'] as const) {
    test.each(['memory', 'sqlite'] as const)(
      `${kind}: repaired pre-dispatch configuration resumes through a new manager with one concurrent acquisition, %s`,
      async (storeKind) => {
        const reached = Promise.withResolvers<void>()
        const release = Promise.withResolvers<void>()
        let requests = 0
        const fetch = vi.fn<(url: string | URL | Request, init?: RequestInit) => Promise<Response>>(
          async () => {
            requests++
            if (requests > 1) {
              reached.resolve()
              await release.promise
            }
            return tokenResponse(kind, requests === 1 ? 'initial-access' : 'recovered-access')
          },
        )
        vi.stubGlobal('fetch', fetch)
        const target = fixture(kind, storeKind)
        try {
          await target.enroll()
          target.setConfigurationAvailable(false)
          await expect(target.manager.credentials(connectionId)).rejects.toMatchObject({
            _tag: 'TemporarilyUnavailable',
            cause: { _tag: 'ProviderFailure' },
          })
          expect(fetch).toHaveBeenCalledTimes(1)
          await expect(target.makeManager().credentials(connectionId)).rejects.toMatchObject({
            _tag: 'TemporarilyUnavailable',
            cause: { _tag: 'ProviderFailure' },
          })
          expect(fetch).toHaveBeenCalledTimes(1)
          await expect(target.manager.inspect(connectionId)).resolves.toEqual({
            savedAuthorization: true,
            credentialWork: 'known-failure',
          })
          target.setConfigurationAvailable(true)
          const reconstructed = target.makeManager()
          const owner = reconstructed.credentials(connectionId)
          await reached.promise
          const followers = Array.from({ length: 5 }, () => reconstructed.credentials(connectionId))
          release.resolve()
          const credentials = await Promise.all([owner, ...followers])
          expect(credentials.map((value) => revealSecret(value.accessToken))).toEqual(
            Array.from({ length: 6 }, () => 'recovered-access'),
          )
          expect(fetch).toHaveBeenCalledTimes(2)
          await expect(reconstructed.inspect(connectionId)).resolves.toEqual({
            savedAuthorization: true,
            credentialWork: 'idle',
          })
          expect(revealSecret((await reconstructed.credentials(connectionId)).accessToken)).toBe(
            'recovered-access',
          )
          expect(fetch).toHaveBeenCalledTimes(2)
        } finally {
          release.resolve()
          target.close()
        }
      },
    )

    test.each(['invalid-json', 'invalid-token-shape'] as const)(
      `${kind}: malformed responses retain uncertainty and are never reacquired on another read, %s`,
      async (malformation) => {
        let requests = 0
        const fetch = vi.fn<(url: string | URL | Request, init?: RequestInit) => Promise<Response>>(
          async () => {
            requests++
            if (requests === 1) return tokenResponse(kind, 'initial-access')
            return malformation === 'invalid-json'
              ? new Response('{')
              : Response.json({ unexpected: 'response' })
          },
        )
        vi.stubGlobal('fetch', fetch)
        const target = fixture(kind, 'sqlite')
        try {
          await target.enroll()
          await expect(target.manager.credentials(connectionId)).rejects.toMatchObject({
            _tag: 'InterventionRequired',
            cause: { _tag: 'ProviderOutcomeUnknown' },
          })
          await expect(target.makeManager().credentials(connectionId)).rejects.toMatchObject({
            _tag: 'InterventionRequired',
            cause: { _tag: 'ProviderOutcomeUnknown' },
          })
          await expect(target.manager.inspect(connectionId)).resolves.toEqual({
            savedAuthorization: true,
            credentialWork: 'intervention-required',
          })
          expect(fetch).toHaveBeenCalledTimes(2)
        } finally {
          target.close()
        }
      },
    )
  }

  test('Salesforce client credentials recover after the My Domain endpoint is repaired', async () => {
    let loginUrl = 'https://login.salesforce.com'
    const fetch = vi.fn<(url: string | URL | Request, init?: RequestInit) => Promise<Response>>(
      async () =>
        Response.json({
          access_token: 'recovered-derived-access',
          token_type: 'Bearer',
          instance_url: 'https://instance.example.test',
        }),
    )
    const store = Memory.store({ encryptionKey })
    const configuredProvider = Salesforce.clientCredentials({ loginUrl: () => loginUrl, fetch })
    const manager = Connections.create({ store, provider: configuredProvider })
    await manager.setClientCredentials(connectionId, { clientId: 'client-id', clientSecret })
    await expect(manager.credentials(connectionId)).rejects.toMatchObject({
      _tag: 'TemporarilyUnavailable',
    })
    expect(fetch).not.toHaveBeenCalled()
    loginUrl = 'https://example.my.salesforce.com'
    const reconstructed = Connections.create({ store, provider: configuredProvider })
    expect(revealSecret((await reconstructed.credentials(connectionId)).accessToken)).toBe(
      'recovered-derived-access',
    )
    expect(fetch).toHaveBeenCalledTimes(1)
  })
})
