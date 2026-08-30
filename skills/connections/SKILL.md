---
name: connections
description: Integrate or extend @indev42/connections for OAuth flows, static API credentials, token storage, credential sources, token encryption, provider adapters, or TokenManager error handling. Use when application code installs, configures, or debugs this library.
---

# Use @indev42/connections

Use the library as the credential boundary between application code and external services. Let `TokenManager` select provider bindings, load and validate records, refresh OAuth tokens, and persist or revoke them.

## Implement an integration

1. Inspect the target project's package manager, runtime, installed `@indev42/connections` version, and existing auth/storage conventions. If the package is installed, treat its exported declarations and bundled README as the API source of truth. Complete this step when the intended imports and runtime dependencies exist in that version.
2. Define one stable `TokenKey` scheme before writing handlers:
   - `provider`: the application's binding namespace.
   - `accountId`: the owning user, tenant, workspace, or external account.
   - `connectionId`: an optional discriminator for multiple connections under the same provider and account.
   Complete this step when every operation for one connection derives the same key.
3. Choose exactly one binding shape:
   - OAuth: `{ adapter, store }`
   - App-managed static credential: `{ adapter, store }`, then `saveCredential`
   - Externally managed static credential: `{ adapter, source }`
   Never combine `store` and `source` in one binding. Complete this step when credential ownership and mutability are explicit.
4. Load only the reference for the selected branch:
   - OAuth with Zoho, Salesforce, or a custom OAuth adapter: [references/oauth.md](references/oauth.md)
   - Static API keys and environment-backed credentials: [references/static-credentials.md](references/static-credentials.md)
   - Memory, Neon, Convex, or encrypted persistence: [references/storage.md](references/storage.md)
   - Custom providers, stores, sources, or encryption: [references/extensions.md](references/extensions.md)
5. Construct a long-lived server-side `TokenManager`. Reuse it across requests when the runtime permits so concurrent refreshes for the same key can be deduplicated. Keep provider secrets, authorization codes, tokens, and encryption keys out of client bundles and logs. Complete this step when all registered namespaces match the `provider` values used by callers.
6. Route application operations through the manager:
   - Start OAuth with `getAuthorizationUrl`.
   - Finish OAuth with `exchangeCodeAndSave`.
   - Save an app-managed static credential with `saveCredential`.
   - Retrieve request credentials with `getValidAccessToken` or `getValidToken`.
   - Disconnect a writable binding with `revoke`.
   Complete this step when application code no longer refreshes or mutates stored token records independently.
7. Verify the integration with the project's typecheck and tests. Exercise the missing-token path, provider callback or static load path, retrieval path, and disconnect/rotation path. Complete this step when credentials remain secret in output and each exercised operation uses the expected complete `TokenKey`.

## Core pattern

```ts
import {
  MemoryTokenStore,
  TokenManager,
  ZohoOAuthProvider,
} from "@indev42/connections";

const store = new MemoryTokenStore(); // Replace for durable deployments.

export const connections = new TokenManager({
  providers: {
    zoho: {
      adapter: new ZohoOAuthProvider({
        credentials: {
          clientId: process.env.ZOHO_CLIENT_ID!,
          clientSecret: process.env.ZOHO_CLIENT_SECRET!,
        },
        defaultScopes: ["ZohoCRM.modules.READ"],
        accessType: "offline",
        prompt: "consent",
      }),
      store,
    },
  },
});
```

Memory storage is suitable for tests, local development, and short-lived processes, not durable multi-instance deployments.

## Preserve these semantics

- Treat the binding map key as durable data. It participates in lookup, persistence identity, encryption context, events, and provider request context. Renaming it requires migrating stored and encrypted records.
- Use epoch milliseconds for `TokenRecord.expiresAt`.
- Let `TokenManager` decide whether an OAuth token needs refresh. `refreshSkewMs` defaults to 60 seconds, while static credentials ignore the skew and expire at their exact `expiresAt`.
- Treat a token with no `expiresAt` as locally usable, not externally verified. The library does not contact a service merely to prove validity.
- Use `connectionId` consistently. Omitting it and setting it produce different persistence identities.
- Prefer `getValidAccessToken` when only the credential string is needed. Use `getValidToken` only when token type, scopes, or metadata are required.
- Use `saveToken` only for an already normalized `TokenRecord`. Use `saveCredential` to ask a static provider to normalize a raw credential. Do not introduce the deprecated `saveInitialToken` alias.
- Treat source-backed bindings as read-only. Rotate or delete the external source rather than calling `saveToken`, `saveCredential`, or `revoke`.
- Do not log token records, raw credentials, authorization codes, client secrets, encrypted payloads, or provider response bodies. `onEvent` is the intended sanitized observability boundary.

## Handle expected failures

Catch narrowly at HTTP or job boundaries and map failures without exposing secrets:

- `TokenNotFoundError`: no stored or sourced credential exists; prompt reconnection or configuration.
- `TokenExpiredError` (`TOKEN_EXPIRED`): a static token reached its known expiration.
- `MissingRefreshTokenError`: an expiring OAuth record cannot refresh; prompt reconnection.
- `ProviderNotRegisteredError` (`PROVIDER_NOT_REGISTERED`): the key's namespace has no binding.
- `ProviderCapabilityError` (`PROVIDER_CAPABILITY_UNAVAILABLE`): the selected binding does not support the requested operation.
- `OAuthProviderError` (`OAUTH_PROVIDER_ERROR`): the remote OAuth service rejected or malformed an operation; use its sanitized `status`, `oauthErrorCode`, and `details` for diagnostics.
- `InvalidTokenRecordError` (`INVALID_TOKEN_RECORD`): malformed data crossed a provider, manager, serialization, or storage boundary.

Preserve the original error as the server-side cause when translating it to an application error. Return a generic client-safe message.