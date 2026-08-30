# OAuth integrations

Use this branch for Zoho, Salesforce, or an application-owned `OAuthProvider`.

## Configure the binding

OAuth bindings always require a writable `TokenStore`:

```ts
import {
  MemoryTokenStore,
  SalesforceOAuthProvider,
  TokenManager,
} from "@indev42/connections";

const manager = new TokenManager({
  providers: {
    salesforce: {
      adapter: new SalesforceOAuthProvider({
        credentials: {
          clientId: process.env.SALESFORCE_CLIENT_ID!,
          clientSecret: process.env.SALESFORCE_CLIENT_SECRET!,
        },
        environment: "production", // Or "sandbox".
        defaultScopes: ["api", "refresh_token"],
      }),
      store: new MemoryTokenStore(),
    },
  },
});
```

Zoho supports `dataCenter`, `accountsUrl`, `defaultScopes`, `accessType`, and `prompt`. Salesforce supports `environment`, `loginUrl`, `defaultScopes`, `display`, and `prompt`. Prefer a documented environment/data center option; use custom URLs only when required.

Credentials may be a value or a resolver. Use a resolver when one binding serves multiple tenants:

```ts
const adapter = new SalesforceOAuthProvider({
  credentials: async ({ key, operation, metadata }) => {
    const tenant = await loadTenantOAuthConfig(key?.accountId, metadata);
    return {
      clientId: tenant.clientId,
      clientSecret: tenant.clientSecret,
    };
  },
});
```

The resolver receives the configured provider namespace, operation, token key when available, and request metadata. Do not derive tenant selection from untrusted metadata alone.

## Start authorization

Generate and persist an application-owned, single-use state value before redirecting. Bind it to the user/session and intended `TokenKey`.

```ts
const key = {
  provider: "salesforce",
  accountId: tenantId,
};

const authorizationUrl = await manager.getAuthorizationUrl({
  key,
  redirectUri: "https://app.example.com/oauth/salesforce/callback",
  state: await issueOAuthState({ userId, key }),
  scopes: ["api", "refresh_token"],
});
```

Redirect the user to the returned URL. Do not put tokens or client secrets in `state` or `metadata`.

## Handle the callback

Validate state before exchanging the code. Reconstruct the same key and exact redirect URI used when authorization started.

```ts
const state = await consumeAndValidateOAuthState(
  callbackUrl.searchParams.get("state"),
  currentUser.id,
);

await manager.exchangeCodeAndSave({
  key: state.key,
  code: callbackUrl.searchParams.get("code")!,
  redirectUri: "https://app.example.com/oauth/salesforce/callback",
});
```

Reject missing codes, invalid or replayed state, and account mismatches before calling the manager.

## Use and disconnect

```ts
const accessToken = await manager.getValidAccessToken(key);

await fetch(serviceUrl, {
  headers: { Authorization: `Bearer ${accessToken}` },
});

await manager.revoke(key);
```

`getValidAccessToken` refreshes and persists an expiring OAuth token when possible. Concurrent refreshes are deduplicated only within the same `TokenManager` instance. `revoke` attempts remote revocation when supported, then deletes the local record; deletion alone does not prove remote invalidation.

## Verify

Test authorization URL generation, state validation, callback exchange and persistence, valid-token retrieval, refresh, and disconnect. Mock provider HTTP at the adapter boundary; do not use production credentials in tests.