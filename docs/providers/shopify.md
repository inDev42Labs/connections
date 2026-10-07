# Connect a Shopify shop

Use `Shopify.oauth(...)` for browser authorization with expiring offline access tokens. Connections saves the access-token and refresh-token pair, renews it on credential reads when necessary, and returns only the access token and shop domain. It does not implement Shopify's online-token, embedded-app token-exchange, or client-credentials flows.

See the [provider catalog](../reference.md#providers) for other providers and [getting started](../getting-started.md) for shared credential workflows.

## Configure the app and shop

Obtain the app's client ID and client secret from Shopify's Dev Dashboard. Configure the access scopes and allowed callback URL for the app. Use a Shopify app configured for the [authorization code grant](https://shopify.dev/docs/apps/build/authentication-authorization/access-tokens#authorization-code-grant), not an Admin API token supplied directly by a merchant.

Create a manager for a trusted shop selected by your server:

```ts
import { DatabaseSync } from 'node:sqlite'
import { Connections } from '@indev42/connections'
import { Shopify } from '@indev42/connections/providers/shopify'
import { SQLite } from '@indev42/connections/stores/sqlite'

const database = new DatabaseSync('connections.sqlite')
const store = SQLite.store({
  database,
  encryptionKey: process.env.CONNECTIONS_ENCRYPTION_KEY!,
})

export const shopify = Connections.create({
  store,
  provider: Shopify.oauth({
    clientId: process.env.SHOPIFY_CLIENT_ID!,
    clientSecret: process.env.SHOPIFY_CLIENT_SECRET!,
    redirectUri: 'https://example.com/oauth/shopify/callback',
    scopes: ['read_products'],
    shopDomain: 'trusted-shop.myshopify.com',
  }),
})
```

Supply a stable 32-byte encryption key as described in [getting started](../getting-started.md#read-an-existing-connection). You can use another built-in store without changing the provider configuration.

- `shopDomain` is a lowercase `<shop>.myshopify.com` hostname without a scheme, path, or port. Custom storefront domains are not accepted. The manager sends authorization and token requests only to this configured shop.
- Select the shop from application-owned, authorized data. Do not use an unchecked browser query parameter to construct a manager or select its saved connection.
- `redirectUri` must match the callback URL configured for the Shopify app. Use HTTPS in production. The adapter permits HTTP only for loopback development.
- `scopes` must be a non-empty list of distinct scope names. The token response must grant the requested scopes.

The code exchange requests `expiring=1` and requires both tokens and their expiry values. Non-expiring offline-token responses are not supported. Connections uses Shopify's returned lifetimes rather than hard-coded token ages.

## Authorize and handle the callback

Follow the shared [browser OAuth workflow](../getting-started.md#connect-through-browser-oauth), using `shopify` instead of `salesforce`. Call `startAuthorization(id, { binding })` from an authenticated setup route. Derive the binding from trusted server-side session evidence.

In the callback route, call `completeAuthorization({ callbackUrl, binding, authorize })`. The adapter validates the configured callback URL, shop domain, and Shopify HMAC signature. Connections also validates saved state and the session binding. Your `authorize` callback must check permission for the recovered connection ID and enrollment or replacement intent before code exchange.

Use `{ binding, replace: true }` to start deliberate reauthorization of an existing connection. Removing a connection cancels earlier local enrollment work but does not revoke authorization at Shopify.

## Use the returned credentials

The following application values and permission check are placeholders, as in getting started. Your application supplies them before reading credentials:

```ts
import { revealSecret } from '@indev42/connections'

await requireConnectionAccess(currentUser, connectionId)
const { accessToken, shopDomain } = await shopify.credentials(connectionId)

// Your application makes the Shopify API request.
const response = await fetch(`https://${shopDomain}/admin/api/2026-10/graphql.json`, {
  method: 'POST',
  headers: {
    'content-type': 'application/json',
    'X-Shopify-Access-Token': revealSecret(accessToken),
  },
  body: JSON.stringify({ query: '{ products(first: 1) { nodes { id title } } }' }),
})
```

Keep this code on the server. Choose an API version supported by your app. `accessToken` stays redacted until revealed at the request boundary. The refresh token and app client secret are not returned. Connections does not make or retry your Shopify API request.

## Keep configuration and refresh ownership stable

Reuse the same app identity, shop domain, store, and encryption key for a saved connection. Changing the shop domain does not move the authorization to another shop. Keep requested scopes consistent with the saved grant; use deliberate reauthorization when the grant needs to change. Plan app-secret rotation against [Shopify's token management guidance](https://shopify.dev/docs/apps/build/authentication-authorization/access-tokens) rather than assuming it is ordinary renewal.

Shopify requires serialized refreshes for each app and shop and atomic persistence of each returned token pair. Connections coordinates operations for one saved connection and persists its pair together. Do not independently refresh the same authorization through another connection ID, store, or system. Those operations are not covered by the connection's coordination.

## Understand renewal failures

The adapter makes at most three refresh attempts after transport failures, HTTP 429, or HTTP 5xx. Configuration, response reading, and retries share a maximum 25-second budget, shortened when operation ownership has less time remaining. The workflow reserves five seconds of its ownership lease for persistence. This is a remote-work budget, not a deadline for storage calls or the complete application request.

Retries normally wait 250ms and then 750ms, with at most one second of total backoff within a read. The adapter respects `Retry-After` seconds or HTTP dates. If the required delay exceeds that allowance or the remaining time budget, it returns `TemporarilyUnavailable` and saves the earliest retry time instead of sleeping longer. A later read before that time returns without another remote attempt. Successful first attempts and reads of usable saved credentials incur no backoff delay.

Shopify's [refresh-token rotation rules](https://shopify.dev/docs/apps/build/authentication-authorization/access-tokens#token-refresh) permit recovery using the previously stored refresh token after a lost response. That token remains usable only until the earliest of replacement-token use, a new authorization-code or token-exchange grant, 30 days after its first refresh use, or its original expiry. This recovery rule does not apply to replaying an authorization code.

A refresh HTTP 401 or locally expired refresh token reports `AuthorizationRequired`. Exhausted transport, throttling, or server-error retries report `TemporarilyUnavailable` while replay remains supported. The retained recovery window is capped by the original refresh-token expiry and 30 days from the earliest possible use recorded for the failed refresh. Later reads do not reset this window. When an unresolved failure's recovery window expires, Connections reports `InterventionRequired`. Malformed successful responses also report it. Other refresh failures can report `TemporarilyUnavailable`. See [retrieval failures](../reference.md#handle-retrieval-failures) for the shared categories.

A refresh failure proven to occur before remote dispatch can resume on a later credential read after you repair configuration. Retained replay evidence also survives reopening storage and reconstructing the manager. Concurrent readers cannot each acquire recovery ownership, and superseded work cannot overwrite newer authorization. Removal and deliberate reauthorization discard the old connection generation's recovery state.

Upgrade workers that share connection storage together before using this retry policy. Older package versions do not understand the new recovery evidence. Convex apps must also regenerate the API and deploy the updated component as described in [Convex setup](../stores/convex.md#mount-the-component).

Older failures and abandoned operations without retained replay evidence remain blocked. Connections does not invent evidence after a lost process or assume that every HTTP failure is safe to replay. Investigate those cases or offer deliberate reauthorization.

The examples and adapter tests use local substitutes. They do not establish live-shop verification.
