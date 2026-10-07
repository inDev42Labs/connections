import type { Database as BunDatabase } from 'bun:sqlite'
import type { DatabaseSync } from 'node:sqlite'
import type { Pool as NeonPool } from '@neondatabase/serverless'
import { Context, Effect, Redacted } from 'effect'
import type { Pool as NodePostgreSQLPool } from 'pg'
import { expectTypeOf } from 'vitest'
import {
  Connections,
  type AuthorizationRequired,
  type TemporarilyUnavailable,
  type InterventionRequired,
  type ConnectionInspection,
  type CredentialConfigurationFailure,
  type CredentialRejectionFailure,
  type RemovalFailure,
  revealSecret,
} from '../../src/index.js'
import { AesGcm, type EncryptionFailure } from '../../src/encryptors/aes-gcm/index.js'
import { ApiKey, type ApiKeyCredentials } from '../../src/providers/api-key/index.js'
import { Salesforce, type SalesforceCredentials } from '../../src/providers/salesforce/index.js'
import { Shopify, type ShopifyCredentials } from '../../src/providers/shopify/index.js'
import { Zoho, type ZohoCredentials } from '../../src/providers/zoho/index.js'
import { Yotpo, type YotpoCredentials } from '../../src/providers/yotpo/index.js'
import { Configuration, type ConfigurationReadFailure } from '../../src/configuration/index.js'
import {
  Convex,
  type ConvexInvocation,
  type ConvexInvocationContext,
  type ConvexQueryInvocation,
  type ConvexQueryInvocationContext,
} from '../../src/stores/convex/index.js'
import type { ComponentApi } from '../../src/stores/convex/component/_generated/component.js'
import type { ConnectionStore } from '../../src/core/contracts/store.js'
import { Memory } from '../../src/stores/memory/index.js'
import { PostgreSQL, PostgreSQLStorageFailure } from '../../src/stores/postgresql/index.js'
import { SQLite, SQLiteStorageFailure } from '../../src/stores/sqlite/index.js'

type Requirements<T> = T extends Effect.Effect<unknown, unknown, infer R> ? R : never
class ProviderConfiguration extends Context.Service<
  ProviderConfiguration,
  { readonly clientId: string }
>()('ProviderConfiguration') {}
class StoreRuntime extends Context.Service<StoreRuntime, { readonly name: string }>()(
  'StoreRuntime',
) {}

const callbackConfiguration = Configuration.string(() => undefined)
expectTypeOf<Effect.Error<typeof callbackConfiguration>>().toEqualTypeOf<ConfigurationReadFailure>()
const provider = Salesforce.oauth({
  clientId: () => 'client-id',
  clientSecret: Configuration.secret('SALESFORCE_CLIENT_SECRET'),
  redirectUri: 'https://example.test/callback',
  scopes: ['api', 'refresh_token'],
})
const key = 'AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE='
const memoryStore = Memory.store({ encryptionKey: key })
const manager = Connections.create({ store: memoryStore, provider })
manager.startAuthorization('id', { binding: 'trusted-session' })
manager.startAuthorization('id', { binding: 'trusted-session', replace: true })
manager.completeAuthorization({
  callbackUrl: 'https://example.test/callback?code=x&state=y',
  binding: 'trusted-session',
  authorize: async (target) => {
    expectTypeOf(target.connectionId).toEqualTypeOf<string>()
  },
})
expectTypeOf<
  Awaited<ReturnType<typeof manager.credentials>>
>().toEqualTypeOf<SalesforceCredentials>()
expectTypeOf<
  Effect.Success<ReturnType<typeof manager.effect.credentials>>
>().toEqualTypeOf<SalesforceCredentials>()
expectTypeOf<Effect.Error<ReturnType<typeof manager.effect.credentials>>>().toEqualTypeOf<
  AuthorizationRequired | TemporarilyUnavailable | InterventionRequired
>()
expectTypeOf<Requirements<ReturnType<typeof manager.effect.credentials>>>().toEqualTypeOf<never>()
expectTypeOf<Awaited<ReturnType<typeof manager.inspect>>>().toEqualTypeOf<ConnectionInspection>()
expectTypeOf<
  Effect.Error<ReturnType<typeof manager.effect.remove>>
>().toEqualTypeOf<RemovalFailure>()
const use = manager.effect.credentialUse('id')
expectTypeOf<
  Effect.Error<ReturnType<Effect.Success<typeof use>['reportRejected']>>
>().toEqualTypeOf<CredentialRejectionFailure>()
declare const credentials: Awaited<ReturnType<typeof manager.credentials>>
// @ts-expect-error Use credentials never expose refresh tokens.
void credentials.refreshToken
// @ts-expect-error Use credentials never expose lifecycle-only application secrets.
void credentials.clientSecret
expectTypeOf(revealSecret(credentials.accessToken)).toEqualTypeOf<string>()
// @ts-expect-error Browser OAuth cannot enroll API keys.
manager.setApiKey('id', 'key')
// @ts-expect-error An OAuth start requires a trusted binding.
manager.startAuthorization('id', {})
// @ts-expect-error Completion requires an application permission callback.
manager.completeAuthorization({ callbackUrl: 'url', binding: 'binding' })
// @ts-expect-error Explicit namespaces are not a supported configuration option.
Connections.create({ store: memoryStore, provider, namespace: 'old' })
// @ts-expect-error A store must implement transactional commands, not get/set.
Connections.create({ provider, store: { get: async () => null } })

const apiKey = Connections.create({ store: memoryStore, provider: ApiKey.opaque({ id: 'retell' }) })
apiKey.setApiKey('id', 'key', { replace: true })
expectTypeOf<Awaited<ReturnType<typeof apiKey.credentials>>>().toEqualTypeOf<ApiKeyCredentials>()
expectTypeOf<
  Effect.Error<ReturnType<typeof apiKey.effect.setApiKey>>
>().toEqualTypeOf<CredentialConfigurationFailure>()
// @ts-expect-error Replacement uses named options, not a positional boolean.
apiKey.setApiKey('id', 'key', true)
// @ts-expect-error API keys have no OAuth start operation.
apiKey.startAuthorization('id', { binding: 'binding' })
// @ts-expect-error API keys cannot save client credentials.
apiKey.setClientCredentials('id', {})
const salesforceClient = Connections.create({
  store: memoryStore,
  provider: Salesforce.clientCredentials({
    loginUrl: Configuration.string(() => 'https://example.my.salesforce.com'),
  }),
})
salesforceClient.setClientCredentials('id', { clientId: 'id', clientSecret: 'secret' })
salesforceClient.setClientCredentials(
  'id',
  { clientId: 'id', clientSecret: Redacted.make('secret') },
  { replace: true },
)
expectTypeOf<
  Awaited<ReturnType<typeof salesforceClient.credentials>>
>().toEqualTypeOf<SalesforceCredentials>()
expectTypeOf<
  Effect.Success<ReturnType<typeof salesforceClient.effect.credentials>>
>().toEqualTypeOf<SalesforceCredentials>()
// @ts-expect-error Client credentials do not support browser authorization.
salesforceClient.startAuthorization('id', { binding: 'binding' })
// @ts-expect-error Sources must include the client secret.
salesforceClient.setClientCredentials('id', { clientId: 'id' })
// @ts-expect-error A My Domain login URL is required.
Salesforce.clientCredentials({})
Salesforce.clientCredentials({
  loginUrl: 'https://example.my.salesforce.com',
  // @ts-expect-error Client credentials do not use a redirect URI.
  redirectUri: 'https://app.test/callback',
})
const yotpoProvider = Yotpo.clientCredentials({ version: 'v1' })
const yotpo = Connections.create({ store: memoryStore, provider: yotpoProvider })
yotpo.setClientCredentials('id', { storeId: 'store-id', apiSecret: 'secret' })
yotpo.setClientCredentials(
  'id',
  { storeId: 'store-id', apiSecret: Redacted.make('secret') },
  { replace: true },
)
expectTypeOf<Awaited<ReturnType<typeof yotpo.credentials>>>().toEqualTypeOf<YotpoCredentials>()
// @ts-expect-error Retained sources are provider-specific.
yotpo.setClientCredentials('id', { clientId: 'id', clientSecret: 'secret' })
Connections.create({
  // @ts-expect-error Age policy is not a supported configuration option.
  store: memoryStore,
  provider: yotpoProvider,
  policy: { maxCredentialAge: 1000 },
})
// @ts-expect-error Yotpo requires an explicit supported version.
Yotpo.clientCredentials({})
// @ts-expect-error Only v1 is supported.
Yotpo.clientCredentials({ version: 'v2' })
const shopify = Connections.create({
  store: memoryStore,
  provider: Shopify.oauth({
    clientId: 'id',
    clientSecret: 'secret',
    redirectUri: 'https://example.test/callback',
    shopDomain: 'example.myshopify.com',
    scopes: ['read_products'],
  }),
})
expectTypeOf<Awaited<ReturnType<typeof shopify.credentials>>>().toEqualTypeOf<ShopifyCredentials>()
const zoho = Connections.create({
  store: memoryStore,
  provider: Zoho.oauth({
    clientId: 'id',
    clientSecret: 'secret',
    redirectUri: 'https://example.test/callback',
    accountsOrigin: 'https://accounts.zoho.com',
    scopes: ['ZohoCRM.modules.ALL'],
  }),
})
expectTypeOf<Awaited<ReturnType<typeof zoho.credentials>>>().toEqualTypeOf<ZohoCredentials>()
const selfClient = Connections.create({
  store: memoryStore,
  provider: Zoho.selfClient({
    clientId: 'id',
    clientSecret: 'secret',
    accountsOrigin: 'https://accounts.zoho.com',
  }),
})
selfClient.enrollCode('id', { code: 'code', authorize: () => undefined })
// @ts-expect-error Self Client is not browser OAuth.
selfClient.completeAuthorization({})
// @ts-expect-error Self Client is not browser OAuth.
selfClient.startAuthorization('id', { binding: 'binding' })
const serviceProvider = Salesforce.oauth({
  clientId: Effect.map(ProviderConfiguration, (c) => c.clientId),
  clientSecret: 'secret',
  redirectUri: 'https://example.test/callback',
  scopes: ['api'],
})
// @ts-expect-error Arbitrary provider Effect requirements are unsupported.
Connections.create({ store: memoryStore, provider: serviceProvider })
declare const serviceStore: ConnectionStore<never, StoreRuntime>
// @ts-expect-error Arbitrary store Effect requirements are unsupported.
Connections.create({ store: serviceStore, provider })

const encryptor = AesGcm.encryptor({ key: Configuration.secret(() => key) })
// @ts-expect-error Advanced encryptors require redacted lazy key configuration.
AesGcm.encryptor({ key: 'plain-key' })
Memory.store({ encryptor })
expectTypeOf<
  Effect.Error<ReturnType<typeof memoryStore.protect>>
>().toEqualTypeOf<EncryptionFailure>()
// @ts-expect-error Production stores do not expose fixture failure controls.
void memoryStore.failNext
// @ts-expect-error Encryption is required.
Memory.store({})
// @ts-expect-error Encryption is required.
Memory.store()
declare const nodeDatabase: DatabaseSync
declare const bunDatabase: BunDatabase
const sqlite = SQLite.store({ database: nodeDatabase, encryptionKey: key })
const bunSqlite = SQLite.store({ database: bunDatabase, encryptor })
expectTypeOf<Effect.Error<ReturnType<typeof sqlite.protect>>>().toEqualTypeOf<
  SQLiteStorageFailure | EncryptionFailure
>()
expectTypeOf<
  Effect.Error<ReturnType<typeof bunSqlite.inspectConnection>>
>().toEqualTypeOf<SQLiteStorageFailure>()
expectTypeOf<Requirements<ReturnType<typeof sqlite.protect>>>().toEqualTypeOf<never>()
Connections.create({ store: sqlite, provider })
// @ts-expect-error A consumer-owned synchronous database is required.
SQLite.store({ encryptor })
// @ts-expect-error Encryption is required.
SQLite.store({ database: nodeDatabase })
declare const pgPool: NodePostgreSQLPool
declare const neonPool: NeonPool
const pg = PostgreSQL.store({ pool: pgPool, encryptionKey: key, schema: 'connections' })
const neon = PostgreSQL.store({ pool: neonPool, encryptor })
expectTypeOf<Effect.Error<ReturnType<typeof pg.protect>>>().toEqualTypeOf<
  PostgreSQLStorageFailure | EncryptionFailure
>()
expectTypeOf<
  Effect.Error<ReturnType<typeof neon.inspectConnection>>
>().toEqualTypeOf<PostgreSQLStorageFailure>()
Connections.create({ store: pg, provider })
// @ts-expect-error A pool with client-scoped transactions is required.
PostgreSQL.store({ pool: { query: pgPool.query }, encryptor })
// @ts-expect-error A consumer-owned pool is required.
PostgreSQL.store({ encryptor })
// @ts-expect-error Encryption is required.
PostgreSQL.store({ pool: pgPool })

declare const component: ComponentApi
declare const ctx: ConvexInvocationContext
declare const queryCtx: ConvexQueryInvocationContext
const convexStore = Convex.store({ component, encryptionKey: () => key })
const convex = Connections.create({ store: convexStore, provider })
expectTypeOf<
  Requirements<ReturnType<typeof convex.effect.credentials>>
>().toEqualTypeOf<ConvexInvocation>()
expectTypeOf<
  Requirements<ReturnType<typeof convex.effect.inspect>>
>().toEqualTypeOf<ConvexQueryInvocation>()
// @ts-expect-error An unbound Convex manager has no Promise credential methods.
convex.credentials('id')
const bound = Convex.bind(ctx, convex)
bound.credentials('id')
bound.completeAuthorization({ callbackUrl: 'url', binding: 'binding', authorize: () => undefined })
expectTypeOf<Awaited<ReturnType<typeof bound.credentials>>>().toEqualTypeOf<SalesforceCredentials>()
const queryBound = Convex.bind(queryCtx, convex)
queryBound.inspect('id')
// @ts-expect-error Queries cannot acquire credentials.
queryBound.credentials('id')
// @ts-expect-error Queries cannot remove authorization.
queryBound.remove('id')
// @ts-expect-error Queries cannot start OAuth.
queryBound.startAuthorization('id', { binding: 'binding' })
Convex.run(ctx, convex.effect.credentials('id'))
Convex.run(queryCtx, convex.effect.inspect('id'))
// @ts-expect-error Queries cannot supply mutation requirements.
Convex.run(queryCtx, convex.effect.credentials('id'))
Convex.run(
  ctx,
  // @ts-expect-error Convex cannot supply arbitrary application services.
  Effect.map(StoreRuntime, (x) => x.name),
)
