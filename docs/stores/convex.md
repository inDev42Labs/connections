# Use Connections with Convex

> **Built-in Convex interface.** `Connections.create`, direct encryption-key setup, `Convex.bind`, and `Convex.run` are available in this checkout. The package's local Convex integration tests run against an anonymous local backend; no cloud deployment was verified.

Use the Convex store when your integration code runs in Convex. Follow the [common credential workflows](../getting-started.md) for API keys, client credentials, and OAuth. Only the store setup and operation execution differ here.

## Mount the component

In `convex/convex.config.ts`, mount the package's component:

```ts
import { defineApp } from 'convex/server'
import connections from '@indev42/connections/stores/convex/convex.config.js'

const app = defineApp()
app.use(connections, { name: 'connections' })
export default app
```

Install a compatible Convex version and run your application's Convex code generation. After a package update, regenerate the API and deploy the updated component with your app before using new lifecycle behavior. The mounted component appears as `components.connections` in the generated API. It owns private connection and operation data. Do not copy its tables into your application schema or expose its internal functions as browser routes. This adapter has been tested against a local Convex 1.45.0 backend, not a Convex cloud deployment.

## Configure a manager without capturing an action context

Create reusable definitions at module scope, for example in `convex/connections.ts`:

```ts
import { Connections } from '@indev42/connections'
import { Convex } from '@indev42/connections/stores/convex'
import { Salesforce } from '@indev42/connections/providers/salesforce'
import { components } from './_generated/api'

const store = Convex.store({
  component: components.connections,
  encryptionKey: () => process.env.CONNECTIONS_ENCRYPTION_KEY!,
})

export const salesforce = Connections.create({
  store,
  provider: Salesforce.oauth({
    clientId: () => process.env.SALESFORCE_CLIENT_ID!,
    clientSecret: () => process.env.SALESFORCE_CLIENT_SECRET!,
    redirectUri: () => process.env.SALESFORCE_REDIRECT_URI!,
    scopes: ['api', 'refresh_token'],
  }),
})
```

The built-in Convex store and Salesforce provider accept these lazy configuration functions. They resolve the key and provider configuration when needed, not when the module loads. Do not capture an invocation `ctx` at module scope. Use stable encryption key material for saved connections.

## Bind the current action for Promise calls

Credential retrieval can perform a provider request and write refreshed credentials. Use an action or HTTP action, not a Convex query or mutation:

```ts
import { action } from './_generated/server'
import { v } from 'convex/values'
import { Convex } from '@indev42/connections/stores/convex'
import { salesforce } from './connections'

export const syncContacts = action({
  args: { connectionId: v.string() },
  handler: async (ctx, { connectionId }) => {
    await requireConnectionAccess(ctx, connectionId) // your app's permission check
    const bound = Convex.bind(ctx, salesforce)
    const { accessToken, instanceUrl } = await bound.credentials(connectionId)
    return syncWithSalesforce({ accessToken, instanceUrl }) // your app's provider request
  },
})
```

`Convex.bind(ctx, salesforce)` supplies the **current** action's read and write capabilities to the same lifecycle operations used elsewhere. It does not create a second refresh path or retain `ctx` globally. Your application owns `requireConnectionAccess`, `syncWithSalesforce`, and every OAuth route and permission check. Never return credentials to a browser.

To start OAuth, complete its callback, save credentials, or report a confirmed rejection, bind the manager inside the relevant action and call the corresponding Promise method from [getting started](../getting-started.md). Callback `authorize` must check the connection ID recovered from the stored attempt.

## Inspect local status in a query

Inspection only reads non-secret metadata, so a query context can bind for this method:

```ts
import { query } from './_generated/server'

export const connectionStatus = query({
  args: { connectionId: v.string() },
  handler: async (ctx, { connectionId }) => {
    await requireConnectionAccess(ctx, connectionId) // your app's permission check
    return Convex.bind(ctx, salesforce).inspect(connectionId)
  },
})
```

A query binding exposes only `inspect` at type-check time, not `credentials`, enrollment, or other lifecycle methods. Inspection does not decrypt or renew credentials and does not prove Salesforce still accepts them.

## Compose an Effect program instead

For Effect composition, use the same operations directly. `Convex.run` supplies invocation-specific requirements and an Effect scope:

```ts
import { Effect } from 'effect'

return Convex.run(
  ctx,
  Effect.gen(function* () {
    const credentials = yield* salesforce.effect.credentials(connectionId)
    return yield* Effect.tryPromise(() => syncWithSalesforce(credentials))
  }),
)
```

`salesforce.effect` and `Convex.run` are both available. Cancellation cannot undo a provider request or storage mutation that has already been dispatched. See [retrieval failures](../reference.md#handle-retrieval-failures) for why some uncertain provider outcomes require intervention.
