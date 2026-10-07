import { Connections } from '@indev42/connections'
import packageManifest from '@indev42/connections/package.json' with { type: 'json' }
import { Effect, Redacted } from 'effect'
import { AesGcm } from '@indev42/connections/encryptors/aes-gcm'
import { ApiKey } from '@indev42/connections/providers/api-key'
import {
  Salesforce,
  type SalesforceCredentials,
  type SalesforceSourceCredentials,
} from '@indev42/connections/providers/salesforce'
import { Shopify } from '@indev42/connections/providers/shopify'
import {
  Yotpo,
  type YotpoCredentials,
  type YotpoSourceCredentials,
} from '@indev42/connections/providers/yotpo'
import { Zoho } from '@indev42/connections/providers/zoho'
import { Configuration } from '@indev42/connections/configuration'
import { Memory } from '@indev42/connections/stores/memory'
import { PostgreSQL } from '@indev42/connections/stores/postgresql'
import { SQLite } from '@indev42/connections/stores/sqlite'

const provider = Salesforce.oauth({
  clientId: Configuration.string(() => 'client-id'),
  clientSecret: Configuration.secret(() => 'client-secret'),
  redirectUri: Configuration.string(() => 'https://app.example.test/callback'),
  scopes: ['api', 'refresh_token'],
})

const salesforceSource: SalesforceSourceCredentials = {
  clientId: 'client-id',
  clientSecret: Redacted.make('client-secret'),
}
const salesforceClient = Connections.create({
  store: Memory.store({ encryptionKey: 'AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE=' }),
  provider: Salesforce.clientCredentials({
    loginUrl: 'https://example.my.salesforce.com',
    fetch: async () =>
      new Response(
        JSON.stringify({
          access_token: 'salesforce-token',
          instance_url: 'https://example.my.salesforce.com',
          token_type: 'Bearer',
        }),
      ),
  }),
})
await salesforceClient.setClientCredentials('salesforce-client', salesforceSource)
const salesforceCredentials: SalesforceCredentials =
  await salesforceClient.credentials('salesforce-client')
if (Redacted.value(salesforceCredentials.accessToken) !== 'salesforce-token')
  throw new Error('Invalid Salesforce client credentials')

const zohoProvider = Zoho.oauth({
  clientId: 'client-id',
  clientSecret: Configuration.secret(() => 'client-secret'),
  redirectUri: 'https://app.example.test/zoho/callback',
  accountsOrigin: 'https://accounts.zoho.com',
  scopes: ['ZohoCRM.modules.ALL'],
})
const shopifyProvider = Shopify.oauth({
  clientId: 'client-id',
  clientSecret: Configuration.secret(() => 'client-secret'),
  redirectUri: 'https://app.example.test/shopify/callback',
  shopDomain: 'example-shop.myshopify.com',
  scopes: ['read_products'],
})
const apiKeyProvider = ApiKey.opaque({ id: 'retell' })

const encryptor = AesGcm.encryptor({
  key: Configuration.secret(() => 'AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE='),
  keyId: 'package-test',
})

if (packageManifest.name !== '@indev42/connections') throw new Error('Invalid package manifest')
if (typeof Connections.create !== 'function') throw new Error('Missing Connections.create')
if (provider.id !== 'salesforce') throw new Error('Invalid Salesforce provider')
if (zohoProvider.id !== 'zoho') throw new Error('Invalid Zoho provider')
if (shopifyProvider.id !== 'shopify') throw new Error('Invalid Shopify provider')
if (apiKeyProvider.id !== 'retell') throw new Error('Invalid generic API-key provider')
if (typeof encryptor.encrypt !== 'function') throw new Error('Invalid AES-GCM encryptor')
if (typeof Memory.store({ encryptor }).execute !== 'function')
  throw new Error('Invalid Memory store')
const sqliteStore = SQLite.store({
  database: {
    exec: () => undefined,
    prepare: () => ({ get: () => undefined, run: () => undefined }),
  },
  encryptor,
})
if (typeof sqliteStore.execute !== 'function') throw new Error('Invalid SQLite store')
let postgreSQLPoolCalls = 0
const postgreSQLStore = PostgreSQL.store({
  pool: {
    connect: () => {
      postgreSQLPoolCalls++
      throw new Error('PostgreSQL pool must remain lazy')
    },
  },
  encryptor,
})
if (typeof postgreSQLStore.execute !== 'function' || postgreSQLPoolCalls !== 0)
  throw new Error('Invalid PostgreSQL store')

const yotpoSource: YotpoSourceCredentials = {
  storeId: 'store-id',
  apiSecret: Redacted.make('api-secret'),
}
const yotpoManager = Connections.create({
  provider: Yotpo.clientCredentials({
    version: 'v1',
    fetch: async () =>
      new Response(JSON.stringify({ access_token: 'yotpo-access-token', token_type: 'bearer' }), {
        headers: { 'content-type': 'application/json' },
      }),
  }),
  store: Memory.store({
    encryptor: AesGcm.encryptor({
      key: Effect.succeed(Redacted.make('AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE=')),
      keyId: 'default',
    }),
  }),
})
const yotpoConnection = yotpoManager.effect
await Effect.runPromise(
  yotpoConnection.setClientCredentials('conn_yotpo', yotpoSource, { replace: false }),
)
const yotpoUse = await Effect.runPromise(yotpoConnection.credentialUse('conn_yotpo'))
const yotpoCredentials: YotpoCredentials = yotpoUse.credentials
if (yotpoCredentials.storeId !== 'store-id') throw new Error('Invalid Yotpo source credentials')
if (Redacted.value(yotpoCredentials.accessToken) !== 'yotpo-access-token')
  throw new Error('Invalid Yotpo access token')
