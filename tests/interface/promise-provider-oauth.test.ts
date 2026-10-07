import { afterEach, describe, expect, test, vi } from 'vitest'
import { Connections, revealSecret, type PromiseOAuthManager } from '../../src/index.js'
import { Shopify, type ShopifyCredentials } from '../../src/providers/shopify/index.js'
import { Zoho, type ZohoCredentials } from '../../src/providers/zoho/index.js'
import { makeInMemoryStore } from '../fixtures/in-memory-store.js'

const shopifyConnectionId = 'promise-shopify-oauth-fixture-connection'
const shopifyBinding = 'trusted-shopify-promise-fixture-session'
const shopifyDomain = 'promise-shopify-fixture.myshopify.com'
const shopifySecret = 'shopify-promise-fixture-client-secret'
const shopifyRedirectUri = 'https://app.example.test/oauth/shopify-promise-fixture/callback'
const zohoConnectionId = 'promise-zoho-oauth-fixture-connection'
const zohoBinding = 'trusted-zoho-promise-fixture-session'
const zohoRedirectUri = 'https://app.example.test/oauth/zoho-promise-fixture/callback'

type TestFetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>

interface TokenRequest {
  readonly url: string
}

function makeTokenSubstitute(responses: readonly Readonly<Record<string, unknown>>[]) {
  const requests: TokenRequest[] = []
  let index = 0
  const fetch = vi.fn<TestFetch>(async (input) => {
    requests.push({ url: String(input) })
    const body = responses[index++]
    if (body === undefined) throw new Error('Unexpected OAuth token request')
    return Response.json(body)
  })
  return { fetch, requests: () => [...requests] }
}

function shopifyTokenResponse(accessToken: string) {
  return {
    access_token: accessToken,
    refresh_token: `${accessToken}-refresh`,
    scope: 'read_products',
    expires_in: 3_600,
    refresh_token_expires_in: 7_776_000,
  }
}

function zohoTokenResponse(accessToken: string) {
  return {
    access_token: accessToken,
    refresh_token: `${accessToken}-refresh`,
    api_domain: 'https://www.zohoapis.example',
    token_type: 'Bearer',
    expires_in: 3_600,
  }
}

function hex(bytes: ArrayBuffer): string {
  return [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}

async function signedShopifyCallback(state: string, code: string): Promise<string> {
  const callback = new URL(shopifyRedirectUri)
  callback.search = new URLSearchParams({
    code,
    host: 'cHJvbWlzZS1zaG9waWZ5LWZpeHR1cmUubXlzaG9waWZ5LmNvbS9hZG1pbg',
    shop: shopifyDomain,
    state,
    timestamp: '1',
  }).toString()
  const parameters = [...callback.searchParams.entries()]
  parameters.sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
  const message = parameters.map(([name, value]) => `${name}=${value}`).join('&')
  const encoder = new TextEncoder()
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(shopifySecret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  callback.searchParams.set(
    'hmac',
    hex(await crypto.subtle.sign('HMAC', key, encoder.encode(message))),
  )
  return callback.toString()
}

function zohoCallback(state: string, code: string): string {
  const callback = new URL(zohoRedirectUri)
  callback.search = new URLSearchParams({ code, state }).toString()
  return callback.toString()
}

async function exerciseDeniedOAuthReplacement<Credentials>(input: {
  readonly connectionId: string
  readonly binding: string
  readonly manager: PromiseOAuthManager<Credentials>
  readonly firstCredentials: (credentials: Credentials) => void
  readonly replacementCredentials: (credentials: Credentials) => void
  readonly callback: (state: string, code: string) => Promise<string>
  readonly assertAuthorizationUrl: (url: URL) => void
  readonly requests: () => readonly TokenRequest[]
  readonly expectedTokenUrl: string
}) {
  const firstStart = await input.manager.startAuthorization(input.connectionId, {
    binding: input.binding,
  })
  const firstUrl = new URL(firstStart.url)
  input.assertAuthorizationUrl(firstUrl)
  const firstState = firstUrl.searchParams.get('state')
  if (firstState === null) throw new Error('Expected OAuth state in authorization URL')
  const firstCallbackUrl = await input.callback(firstState, 'promise-fixture-initial-code')

  await input.manager.completeAuthorization({
    callbackUrl: firstCallbackUrl,
    binding: input.binding,
    authorize: ({ connectionId, intent }) => {
      expect({ connectionId, intent }).toEqual({
        connectionId: input.connectionId,
        intent: 'enroll',
      })
    },
  })
  input.firstCredentials(await input.manager.credentials(input.connectionId))
  expect(input.requests()).toHaveLength(1)
  expect(input.requests()[0]?.url).toBe(input.expectedTokenUrl)

  await expect(
    input.manager.startAuthorization(input.connectionId, { binding: input.binding }),
  ).rejects.toMatchObject({ reason: 'Conflict' })
  const replacementStart = await input.manager.startAuthorization(input.connectionId, {
    binding: input.binding,
    replace: true,
  })
  const replacementUrl = new URL(replacementStart.url)
  input.assertAuthorizationUrl(replacementUrl)
  const replacementState = replacementUrl.searchParams.get('state')
  if (replacementState === null) throw new Error('Expected replacement state in authorization URL')
  const replacementCallbackUrl = await input.callback(
    replacementState,
    'promise-fixture-replacement-code',
  )
  const denied = new Error('Application denied OAuth replacement')

  await expect(
    input.manager.completeAuthorization({
      callbackUrl: replacementCallbackUrl,
      binding: input.binding,
      authorize: ({ connectionId, intent }) => {
        expect({ connectionId, intent }).toEqual({
          connectionId: input.connectionId,
          intent: 'replace',
        })
        throw denied
      },
    }),
  ).rejects.toBe(denied)
  expect(input.requests()).toHaveLength(1)
  input.firstCredentials(await input.manager.credentials(input.connectionId))

  await expect(
    input.manager.completeAuthorization({
      callbackUrl: replacementCallbackUrl,
      binding: input.binding,
      authorize: ({ connectionId, intent }) => {
        expect({ connectionId, intent }).toEqual({
          connectionId: input.connectionId,
          intent: 'replace',
        })
      },
    }),
  ).resolves.toEqual({ connectionId: input.connectionId })
  input.replacementCredentials(await input.manager.credentials(input.connectionId))
  expect(input.requests()).toHaveLength(2)
  expect(input.requests()[1]?.url).toBe(input.expectedTokenUrl)
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('Promise OAuth provider integrations', () => {
  test('runs Shopify OAuth start, denied and approved replacement completion, and provider-specific reads locally', async () => {
    const fixture = makeTokenSubstitute([
      shopifyTokenResponse('shopify-promise-fixture-initial-token'),
      shopifyTokenResponse('shopify-promise-fixture-replacement-token'),
    ])
    vi.stubGlobal('fetch', fixture.fetch)
    const manager = Connections.create({
      store: makeInMemoryStore(),
      provider: Shopify.oauth({
        clientId: 'shopify-promise-fixture-client-id',
        clientSecret: shopifySecret,
        redirectUri: shopifyRedirectUri,
        scopes: ['read_products'],
        shopDomain: shopifyDomain,
      }),
    })

    await exerciseDeniedOAuthReplacement({
      connectionId: shopifyConnectionId,
      binding: shopifyBinding,
      manager,
      firstCredentials: (credentials: ShopifyCredentials) => {
        expect(Object.keys(credentials).sort()).toEqual(['accessToken', 'shopDomain'])
        expect(revealSecret(credentials.accessToken)).toBe('shopify-promise-fixture-initial-token')
        expect(credentials.shopDomain).toBe(shopifyDomain)
      },
      replacementCredentials: (credentials: ShopifyCredentials) => {
        expect(Object.keys(credentials).sort()).toEqual(['accessToken', 'shopDomain'])
        expect(revealSecret(credentials.accessToken)).toBe(
          'shopify-promise-fixture-replacement-token',
        )
        expect(credentials.shopDomain).toBe(shopifyDomain)
      },
      callback: (state, code) => signedShopifyCallback(state, code),
      assertAuthorizationUrl: (url) => {
        expect(url.origin).toBe(`https://${shopifyDomain}`)
        expect(url.pathname).toBe('/admin/oauth/authorize')
        expect(url.searchParams.get('client_id')).toBe('shopify-promise-fixture-client-id')
      },
      requests: fixture.requests,
      expectedTokenUrl: `https://${shopifyDomain}/admin/oauth/access_token`,
    })
  })

  test('runs Zoho OAuth start, denied and approved replacement completion, and provider-specific reads locally', async () => {
    const fixture = makeTokenSubstitute([
      zohoTokenResponse('zoho-promise-fixture-initial-token'),
      zohoTokenResponse('zoho-promise-fixture-replacement-token'),
    ])
    vi.stubGlobal('fetch', fixture.fetch)
    const manager = Connections.create({
      store: makeInMemoryStore(),
      provider: Zoho.oauth({
        clientId: 'zoho-promise-fixture-client-id',
        clientSecret: 'zoho-promise-fixture-client-secret',
        redirectUri: zohoRedirectUri,
        scopes: ['ZohoCRM.modules.ALL'],
        accountsOrigin: 'https://accounts.zoho.example',
      }),
    })

    await exerciseDeniedOAuthReplacement({
      connectionId: zohoConnectionId,
      binding: zohoBinding,
      manager,
      firstCredentials: (credentials: ZohoCredentials) => {
        expect(Object.keys(credentials).sort()).toEqual(['accessToken', 'apiDomain'])
        expect(revealSecret(credentials.accessToken)).toBe('zoho-promise-fixture-initial-token')
        expect(credentials.apiDomain).toBe('https://www.zohoapis.example')
      },
      replacementCredentials: (credentials: ZohoCredentials) => {
        expect(Object.keys(credentials).sort()).toEqual(['accessToken', 'apiDomain'])
        expect(revealSecret(credentials.accessToken)).toBe('zoho-promise-fixture-replacement-token')
        expect(credentials.apiDomain).toBe('https://www.zohoapis.example')
      },
      callback: async (state, code) => zohoCallback(state, code),
      assertAuthorizationUrl: (url) => {
        expect(url.origin).toBe('https://accounts.zoho.example')
        expect(url.pathname).toBe('/oauth/v2/auth')
        expect(url.searchParams.get('client_id')).toBe('zoho-promise-fixture-client-id')
        expect(url.searchParams.get('code_challenge_method')).toBe('S256')
      },
      requests: fixture.requests,
      expectedTokenUrl: 'https://accounts.zoho.example/oauth/v2/token',
    })
  })
})
