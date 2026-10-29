import { Connections, revealSecret } from '@indev42/connections'
import { Amazon, type AmazonCredentials } from '@indev42/connections/providers/amazon'
import { Memory } from '@indev42/connections/stores/memory'
import { Effect } from 'effect'

const manager = Connections.create({
  store: Memory.store({ encryptionKey: 'AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE=' }),
  provider: Amazon.oauth({
    clientId: () => 'amazon-client-id',
    clientSecret: 'amazon-client-secret',
    redirectUri: 'https://app.example.test/amazon/callback',
    scopes: ['advertising::campaign_management'],
    region: 'na',
  }),
})
const start = await manager.startAuthorization('amazon', { binding: 'trusted-session' })
const authorization = new URL(start.url)
if (authorization.origin !== 'https://www.amazon.com')
  throw new Error('Invalid Amazon authorization URL')
const callback = new URL('https://app.example.test/amazon/callback')
callback.searchParams.set('code', 'amazon-code')
callback.searchParams.set('state', authorization.searchParams.get('state')!)
const originalFetch = globalThis.fetch
try {
  globalThis.fetch = async (url, options) => {
    if (String(url) !== 'https://api.amazon.com/auth/o2/token' || options?.method !== 'POST') {
      throw new Error('Unexpected Amazon token request')
    }
    return Response.json({
      access_token: 'amazon-token',
      refresh_token: 'amazon-refresh',
      token_type: 'bearer',
      expires_in: 3600,
    })
  }
  await manager.completeAuthorization({
    callbackUrl: callback.toString(),
    binding: 'trusted-session',
    authorize: () => undefined,
  })
  const credentials: AmazonCredentials = await manager.credentials('amazon')
  if (revealSecret(credentials.accessToken) !== 'amazon-token')
    throw new Error('Invalid Amazon credentials')
  if (Object.keys(credentials).join(',') !== 'accessToken')
    throw new Error('Amazon credentials exposed lifecycle material')
  const effectCredentials: AmazonCredentials = await Effect.runPromise(
    manager.effect.credentials('amazon'),
  )
  if (revealSecret(effectCredentials.accessToken) !== 'amazon-token')
    throw new Error('Invalid Amazon Effect credentials')
} finally {
  globalThis.fetch = originalFetch
}

function rejectedUsage(credentials: AmazonCredentials) {
  // @ts-expect-error Browser OAuth cannot save API keys.
  manager.setApiKey('amazon', 'key')
  // @ts-expect-error Browser OAuth cannot import refresh tokens.
  manager.setClientCredentials('amazon', { refreshToken: 'token' })
  Amazon.oauth({
    clientId: 'id',
    clientSecret: 'secret',
    redirectUri: 'https://app.test/callback',
    // @ts-expect-error Scopes are required and cannot be empty.
    scopes: [],
  })
  Amazon.oauth({
    clientId: 'id',
    clientSecret: 'secret',
    redirectUri: 'https://app.test/callback',
    scopes: ['profile'],
    // @ts-expect-error Region values are constrained to Amazon's documented endpoints.
    region: 'other',
  })
  // @ts-expect-error Use credentials exclude refresh tokens.
  void credentials.refreshToken
  // @ts-expect-error Use credentials exclude application secrets.
  void credentials.clientSecret
  // @ts-expect-error Access tokens must be explicitly revealed.
  const token: string = credentials.accessToken
  void token
}
void rejectedUsage
