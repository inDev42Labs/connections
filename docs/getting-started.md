# Get credentials for a connection

> **Built-in interface.** `Connections.create`, Promise methods, `revealSecret`, `manager.effect`, and `Convex.bind` are available in this checkout. The examples use built-in providers and stores. Your application must supply the indicated authentication, permission checks, and provider API calls. Custom providers and stores requiring additional Effect services are unsupported.

Connections stores credentials for a connection to an external provider. When you request credentials, it decrypts them and renews them when it can do so safely. Your application chooses the connection ID, checks who may use it, and makes its own provider API requests.

This guide uses SQLite for a concrete server-side example. You can substitute another store without changing the authorization steps. For the full list of supported OAuth, client-credentials, and API-key providers, see the [provider reference](reference.md#providers). For available stores and their setup guides, see the [store reference](reference.md#stores).

**What comes from your application:** `currentUser`, `connectionId`, `request`, `suppliedApiKey`, `storeId`, `apiSecret`, and every `require...` or `callSalesforce` function below are illustrative application code, not Connections exports. Your app obtains inputs from authenticated requests, owns its permission checks, and supplies its provider API client. The examples reuse the configured `store` and `salesforce` values; setup and request snippets run at different times. Package imports appear where they are first needed.

## Read an existing connection

First, see what using a connection looks like. If you have not authorized one yet, this read will fail with `AuthorizationRequired`; the sections below show how to save credentials. Configure an open SQLite database, an encryption key, and a provider:

```ts
import { DatabaseSync } from 'node:sqlite'
import { Connections } from '@indev42/connections'
import { SQLite } from '@indev42/connections/stores/sqlite'
import { Salesforce } from '@indev42/connections/providers/salesforce'

const database = new DatabaseSync('connections.sqlite')
const store = SQLite.store({
  database,
  encryptionKey: process.env.CONNECTIONS_ENCRYPTION_KEY!,
})

export const salesforce = Connections.create({
  store,
  provider: Salesforce.oauth({
    clientId: process.env.SALESFORCE_CLIENT_ID!,
    clientSecret: process.env.SALESFORCE_CLIENT_SECRET!,
    redirectUri: 'https://example.com/oauth/salesforce/callback',
    scopes: ['api', 'refresh_token'],
  }),
})
```

Generate a 32-byte encryption key with `openssl rand -base64 32`. Keep it in server configuration. Never change the key for saved connections without migrating them. `SQLite.store({ database, encryptionKey })` handles encryption without a separate encryptor.

In an authenticated server-side handler, check permission and read the connection:

```ts
import { revealSecret } from '@indev42/connections'

await requireConnectionAccess(currentUser, connectionId) // your app's permission check
const { accessToken, instanceUrl } = await salesforce.credentials(connectionId)

// Your application makes the provider request. Reveal the token only here:
const response = await fetch(new URL('/services/data/v61.0/limits', instanceUrl), {
  headers: { authorization: `Bearer ${revealSecret(accessToken)}` },
})
```

`credentials(id)` returns provider-specific credentials, not a Salesforce API client. The access token is a redacted secret to reduce accidental logging; `instanceUrl` is a normal string. `revealSecret` is exported by Connections, so the Promise path does not require an `effect` import. Connections checks local expiry and refreshes before returning credentials when it can safely do so. It does not know whether Salesforce will accept a later application request.

If no authorization is saved, retrieval fails with `AuthorizationRequired`. A failed operation can also be temporarily unavailable or require intervention; see [retrieval outcomes](reference.md#handle-retrieval-failures).

## Save and read an API key

Choose a stable provider ID for an opaque key. Your application still checks permission before accepting or reading the key:

```ts
import { ApiKey } from '@indev42/connections/providers/api-key'

const retell = Connections.create({
  store,
  provider: ApiKey.opaque({ id: 'retell' }),
})

await requireConnectionSetupPermission(currentUser, connectionId) // your app's permission check
await retell.setApiKey(connectionId, suppliedApiKey) // suppliedApiKey comes from your app

// In a later authenticated server-side request:
await requireConnectionAccess(currentUser, connectionId) // your app's permission check
const { apiKey } = await retell.credentials(connectionId)
```

`setApiKey` enrolls a new key and fails if the connection already has one. To replace an existing key deliberately, call `setApiKey(connectionId, newKey, { replace: true })`; replacement fails if no key exists. The setup methods accept ordinary secret strings and protect them before reporting success; returned secret fields are redacted secrets. Connections stores the key encrypted; it neither creates the key at Retell nor makes Retell requests. Only reveal the redacted `apiKey` when you pass it to your provider client.

## Save client credentials and read a derived credential

For providers that issue access credentials from a retained source credential, save the source once. Connections acquires the derived credential when you first read it and reacquires it when necessary:

```ts
import { Yotpo } from '@indev42/connections/providers/yotpo'

const yotpo = Connections.create({
  store,
  provider: Yotpo.clientCredentials({ version: 'v1' }),
})

await requireConnectionSetupPermission(currentUser, connectionId) // your app's permission check
await yotpo.setClientCredentials(connectionId, { storeId, apiSecret }) // your app's input

// In a later authenticated server-side request:
await requireConnectionAccess(currentUser, connectionId) // your app's permission check
const { accessToken } = await yotpo.credentials(connectionId)
```

When the source credential changes, call `setClientCredentials(connectionId, newSource, { replace: true })`. By default, `setClientCredentials` fails if a source is already saved; replacement fails if none is saved. A rejected derived access credential does not automatically mean that the saved source credential is invalid.

## Connect through browser OAuth

To create the Salesforce connection used in the first example, start authorization from a server-side route. Authenticate the caller, authorize setup, and derive a binding from trusted session evidence:

```ts
// In your connect route:
const { connectionId, binding } = await requireConnectPermission(request) // your app's auth and session check
const { url } = await salesforce.startAuthorization(connectionId, { binding })
return Response.redirect(url, 303)
```

The browser visits the provider and returns to your configured callback route. On that route, recover the same trusted binding and check permission for the connection ID recovered from the saved attempt:

```ts
// In your callback route:
const binding = await requireCallbackSessionBinding(request) // your app's session check
const { connectionId } = await salesforce.completeAuthorization({
  callbackUrl: request.url,
  binding,
  authorize: async ({ connectionId, intent }) => {
    await requireCompletionPermission(request, { connectionId, intent }) // your app's permission check
  },
})

return Response.redirect(`/integrations/${connectionId}`, 303)
```

The library generates OAuth state, validates the callback and session binding, exchanges the code, and stores protected credentials. It does **not** authenticate your user or decide who owns the connection. Never use an arbitrary browser-supplied string as the binding. The same start operation can explicitly request replacement of an existing authorization with `{ binding, replace: true }`; it must not overwrite one by accident.

After completion, read the credentials as shown in [Read an existing connection](#read-an-existing-connection).

## When the provider rejects a credential

Connections does not make your provider API request, so it cannot see its authentication response. When your application needs to report a confirmed rejection, request a credential use tied to that specific read:

```ts
const use = await salesforce.credentialUse(connectionId)
const response = await callSalesforce(use.credentials) // your app's provider request

if (response.status === 401) {
  await use.reportRejected()
}
```

A late report must not invalidate credentials that were renewed after this read. Report only a confirmed credential rejection; do not treat every failed request as one. Connections does not retry the provider API request for you.

## Use Effect when you need composition

Promise methods do not require your application to import Effect. To compose the same operations in Effect programs, see [Use Connections with Effect](effect.md).
