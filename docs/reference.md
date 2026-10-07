# Connections reference

> **Public interface.** Create managers with `Connections.create`. Use their Promise methods or compose the same operations through `manager.effect`. Providers and stores requiring arbitrary additional Effect services are unsupported. See [Get credentials for a connection](getting-started.md) for the common path.

## Create a connection manager

```ts
const manager = Connections.create({ store, provider })
```

The store persists encrypted credentials; the provider definition describes how to prepare, exchange, renew, and project credentials for one external provider. Construction should not read storage, fetch a token, or resolve a request context. A connection ID is chosen by your application and is **not** proof that a caller may access it. Reuse the same stable provider identity, store, and encryption key to read an existing connection. There is no public namespace option for separating otherwise identical provider registrations in one store.

`Connections.create` is the sole manager constructor. A standard manager has Promise methods for application use. `manager.effect.<method>(...)` returns the equivalent operation as an Effect for composition. Both interfaces preserve the same results, failures, and lifecycle guarantees. Promise consumers do not need to import Effect or compose Effect programs. Provider and store definitions must not require additional Effect services, except for the built-in Convex store's [invocation binding](stores/convex.md).

## Methods

| Method | Purpose | Important condition |
| --- | --- | --- |
| `credentials(id)` | Return provider-specific usable credentials; safely renew when necessary. | Fails rather than returning known expired credentials. |
| `credentialUse(id)` | Return `{ credentials, reportRejected() }`. | Report only a confirmed rejection of that read; a stale report cannot invalidate newer credentials. |
| `inspect(id)` | Read local, non-secret status without decrypting or refreshing. | Does not prove the provider will accept the credentials. |
| `remove(id)` | Remove locally stored authorization. | Does not revoke access at the provider. |
| `setApiKey(id, apiKey, options?)` | Enroll a new opaque key; `{ replace: true }` replaces an existing one. | Enrollment fails if a key exists; replacement fails if none exists. |
| `setClientCredentials(id, source, options?)` | Save a provider-specific source; `{ replace: true }` replaces it. | Enrollment fails if a source exists; replacement fails if none exists. The derived credential is acquired on read. |
| `startAuthorization(id, { binding })` | Start browser OAuth; return `{ url, expiresAt }`. | Requires a trusted server-derived session binding and an unused connection. |
| `startAuthorization(id, { binding, replace: true })` | Deliberately reauthorize an existing connection. | Does not silently overwrite it. |
| `completeAuthorization({ callbackUrl, binding, authorize })` | Validate a callback, check app permission, exchange the code, and return `{ connectionId }`. | `authorize` receives the saved target and intent, not an untrusted browser-selected ID. |
| `enrollCode(id, { code, authorize, replace? })` | Exchange an operator-supplied Zoho Self Client code. | `authorize` runs before the one-use exchange; `{ replace: true }` requires saved authorization. |

Methods appear only when the configured provider supports them. `options` defaults to enrollment; use the named `{ replace: true }` option for an intentional overwrite, not a positional boolean. Renewal uses provider-reported expiry and confirmed rejection, not a configurable maximum credential age. The provider-specific shape returned by `credentials` is the object you pass to your own SDK or HTTP request. Secret fields stay redacted. Import `revealSecret` from `@indev42/connections` to convert one to a string at the SDK or HTTP boundary. The Promise path needs no direct `effect` import or dependency; Effect-native consumers import `effect` directly. The exact field names for a provider belong to its provider definition; this library does not expose a universal token or API client.

## Providers

| Provider definition | Mechanism | Setup distinction |
| --- | --- | --- |
| `ApiKey.opaque({ id })` | Opaque API key | Choose a stable ID; save a key locally. No provider network request on save. |
| `Salesforce.oauth({ clientId, clientSecret, redirectUri, scopes })` | Browser OAuth | See [Salesforce browser OAuth](providers/salesforce.md#browser-oauth). |
| `Salesforce.clientCredentials({ loginUrl })` | Source-to-derived client credentials | See [Salesforce client credentials](providers/salesforce.md#client-credentials). |
| `Shopify.oauth(...)` | Browser OAuth | Provider-specific app and shop configuration is required. |
| `Zoho.oauth(...)` | Browser OAuth | See [Zoho browser OAuth](providers/zoho.md#browser-oauth). |
| `Zoho.selfClient(...)` | Operator-supplied OAuth code | See [Zoho Self Client enrollment](providers/zoho.md#self-client-enrollment). |
| `Yotpo.clientCredentials({ version: 'v1' })` | Source-to-derived client credentials | Save the Store ID and API secret; derived access credentials are acquired on read. |

## Stores

| Store | Configuration | When to use it |
| --- | --- | --- |
| `SQLite.store({ database, encryptionKey })` | Supply a synchronous database and stable key. | A server process owns a SQLite database; see [getting started](getting-started.md). |
| `PostgreSQL.store({ pool, encryptionKey, schema? })` | Supply a compatible pool and stable key. | A server application uses PostgreSQL; see [PostgreSQL setup](stores/postgresql.md). |
| `Convex.store({ component, encryptionKey })` | Mount the component; bind its action context for Promise calls. | Code runs in Convex; see [Convex setup](stores/convex.md). |
| `Memory.store({ encryptionKey })` | No external database. | Tests and process-local use only; data is lost on restart. |

Built-in stores accept `encryptionKey` directly and use AES-256-GCM to bind saved secrets to the connection identity. The `encryptor` option also accepts the built-in `AesGcm.encryptor`. Changing the key without migration makes saved credentials unreadable. Keep secrets on the server, including the key used to encrypt them.

## Supported integrations

Supported integrations are the built-in providers, stores, and AES-256-GCM encryptor. Custom-provider, custom-store, and custom-encryptor extension APIs are deferred. Structurally compatible implementations are not deliberately blocked, but compatibility does not make their internal contracts supported public APIs.

## Handle retrieval failures

Promise credential reads reject with one of these actionable categories:

| Category | Meaning | Caller action |
| --- | --- | --- |
| `AuthorizationRequired` | No usable authorization is saved. | Offer setup or reauthorization. |
| `TemporarilyUnavailable` | Concurrent work or a provider or store failure prevents a read. | Retry later with a bound, after the underlying failure is resolved; do not start duplicate authorization automatically. |
| `InterventionRequired` | A provider outcome is uncertain, or an encryption or conflict failure prevents safe use. | Investigate the saved state or offer reconnect; do not blindly retry a remote exchange. |

An absent authorization or known provider rejection maps to `AuthorizationRequired`. Pending renewal, provider failure, or storage failure maps to `TemporarilyUnavailable`. An uncertain provider outcome, encryption failure, or conflict maps to `InterventionRequired`. No interface can guarantee a provider will accept a credential after it has been returned. Report a confirmed rejection from your own provider request through `credentialUse(id).reportRejected()`; Connections does not retry that request.

A lost response after an OAuth code exchange or refresh does not prove the provider left the code or refresh token unused. Connections may require intervention rather than blindly replay a potentially consumed request.

Setup, replacement, inspection, rejection reporting, and removal have their own failure types. Application-supplied authorization callbacks can also fail; Connections does not make application permission decisions. These failures must not leak secret values. See the exported failure types for their current reason values.

## Security and ownership

- Authenticate and authorize callers before setup, read, inspection, replacement, rejection reporting, or removal. Connections does not own users or tenant-to-connection mappings.
- Derive OAuth `binding` from authenticated, server-verified session evidence and check the recovered connection ID at callback completion. Never use a browser-controlled binding or assume the connection ID is permission.
- Keep credentials in server-side code. Call `revealSecret` only at the SDK or HTTP boundary. Redaction is not encryption.
- `remove(id)` deletes local authorization, not provider-side authorization. A credential already handed to application code cannot be recalled.
- Store and provider configuration differ by adapter. Only add adapter-specific setup to the relevant store or provider guide, not to the common workflow.
