# @indev42/connections

OAuth token management for app integrations. This package provides a small core `TokenManager`, provider adapters, and token stores for persisting access and refresh tokens.

## Quickstart

Install the package:

```sh
bun add @indev42/connections
```

Create a manager with a store and provider:

```ts
import {
  MemoryTokenStore,
  TokenManager,
  ZohoOAuthProvider,
} from "@indev42/connections";

const manager = new TokenManager({
  store: new MemoryTokenStore(),
  providers: [
    new ZohoOAuthProvider({
      credentials: {
        clientId: process.env.ZOHO_CLIENT_ID!,
        clientSecret: process.env.ZOHO_CLIENT_SECRET!,
      },
      defaultScopes: ["ZohoCRM.modules.READ"],
      accessType: "offline",
      prompt: "consent",
    }),
  ],
});

const key = {
  provider: "zoho",
  accountId: "user-or-tenant-id",
};
```

Start OAuth by sending the user to an authorization URL:

```ts
const authorizationUrl = await manager.getAuthorizationUrl({
  key,
  redirectUri: "https://app.example.com/oauth/zoho/callback",
  scopes: ["ZohoCRM.modules.READ", "ZohoCRM.settings.READ"],
  state: "csrf-token",
});
```

Handle the OAuth callback and save the returned token:

```ts
await manager.exchangeCodeAndSave({
  key,
  code: callbackUrl.searchParams.get("code")!,
  redirectUri: "https://app.example.com/oauth/zoho/callback",
});
```

Use a valid access token later. The manager refreshes expired tokens automatically when a refresh token is available:

```ts
const accessToken = await manager.getValidAccessToken(key);

await fetch("https://www.zohoapis.com/crm/v2/Leads", {
  headers: {
    Authorization: `Bearer ${accessToken}`,
  },
});
```

Revoke and delete a saved connection:

```ts
await manager.revoke(key);
```

## Core Concepts

`TokenManager` coordinates providers and stores. It selects providers by `key.provider`, persists exchanged tokens, returns valid access tokens, refreshes expired tokens, deduplicates concurrent refreshes for the same token key, and deletes tokens on revoke.

`TokenKey` identifies one saved connection:

```ts
type TokenKey = {
  provider: string;
  accountId: string;
  connectionId?: string;
};
```

Use `accountId` for your user, tenant, workspace, or external account identifier. Use `connectionId` when the same account can have more than one connection for the same provider.

`TokenRecord` is the stored token shape:

```ts
type TokenRecord = {
  accessToken: string;
  refreshToken?: string;
  expiresAt?: number;
  tokenType?: string;
  scopes?: string[];
  metadata?: Record<string, unknown>;
};
```

`expiresAt` is an epoch millisecond timestamp. Tokens without `expiresAt` are treated as valid until revoked or deleted.

## TokenManager Configuration

```ts
const manager = new TokenManager({
  store,
  providers: [zohoProvider],
  refreshSkewMs: 60_000,
});
```

Options:

- `store`: required `TokenStore` implementation.
- `providers`: optional list of `OAuthProvider` implementations. You can also register providers later with `manager.use(provider)`.
- `refreshSkewMs`: how early to refresh expiring tokens. Defaults to `60_000`.
- `now`: optional clock override, mainly for tests.

Common methods:

- `getAuthorizationUrl({ key, redirectUri, scopes, state, metadata })`
- `exchangeCodeAndSave({ key, code, redirectUri, metadata })`
- `saveInitialToken({ key, token })`
- `getValidToken(key, { metadata })`
- `getValidAccessToken(key, { metadata })`
- `revoke(key, { metadata })`

## Zoho Provider

```ts
import { ZohoOAuthProvider } from "@indev42/connections/providers/zoho";

const zohoProvider = new ZohoOAuthProvider({
  credentials: {
    clientId: process.env.ZOHO_CLIENT_ID!,
    clientSecret: process.env.ZOHO_CLIENT_SECRET!,
  },
  dataCenter: "com",
  defaultScopes: ["ZohoCRM.modules.READ"],
  accessType: "offline",
  prompt: "consent",
});
```

Options:

- `credentials`: required OAuth client credentials. Provide a static object or a resolver function.
- `accountsUrl`: optional full Zoho accounts URL override.
- `dataCenter`: optional Zoho data center. Supported values are `"com"`, `"com.au"`, `"eu"`, `"in"`, `"com.cn"`, `"jp"`, `"sa"`, and `"ca"`.
- `defaultScopes`: scopes used when `getAuthorizationUrl` is called without `scopes`.
- `accessType`: `"offline"` or `"online"`. Defaults to `"offline"`.
- `prompt`: optional Zoho prompt value, commonly `"consent"`.

Dynamic credentials are useful when client credentials vary by tenant or environment:

```ts
const zohoProvider = new ZohoOAuthProvider({
  credentials: async ({ provider, operation, metadata }) => {
    const tenantId = metadata?.tenantId as string;
    const credentials = await loadCredentialsForTenant(tenantId, provider);

    return {
      clientId: credentials.clientId,
      clientSecret: operation === "authorizationUrl" ? undefined : credentials.clientSecret,
    };
  },
});
```

## Salesforce Provider

```ts
import { SalesforceOAuthProvider } from "@indev42/connections/providers/salesforce";

const salesforceProvider = new SalesforceOAuthProvider({
  credentials: {
    clientId: process.env.SALESFORCE_CLIENT_ID!,
    clientSecret: process.env.SALESFORCE_CLIENT_SECRET!,
  },
  environment: "production",
  defaultScopes: ["api", "refresh_token"],
});
```

Options:

- `credentials`: required OAuth client credentials. Provide a static object or a resolver function.
- `loginUrl`: optional full Salesforce login or My Domain URL, such as `"https://acme.my.salesforce.com"`. When set, it overrides `environment`.
- `environment`: `"production"` or `"sandbox"`. Defaults to `"production"`, using `https://login.salesforce.com`. Sandbox uses `https://test.salesforce.com`.
- `defaultScopes`: scopes used when `getAuthorizationUrl` is called without `scopes`. Salesforce scopes are sent as a space-delimited list.
- `display`: optional Salesforce authorization display value.
- `prompt`: optional Salesforce prompt value.

Salesforce token responses include org-specific metadata such as `instance_url`, `id`, `issued_at`, and `signature`. The provider stores those values on `token.metadata` using camel-cased keys:

```ts
const token = await manager.getValidToken({
  provider: "salesforce",
  accountId: "user-or-tenant-id",
});

const instanceUrl = token.metadata?.instanceUrl as string;

await fetch(`${instanceUrl}/services/data/v61.0/sobjects/Account`, {
  headers: {
    Authorization: `Bearer ${token.accessToken}`,
  },
});
```

Salesforce does not normally include `expires_in` in web server flow token responses. When no expiry is returned, the saved token does not include `expiresAt` and is treated as valid until revoked or replaced.

## Stores

### MemoryTokenStore

`MemoryTokenStore` is useful for tests, local development, and short-lived processes. It does not persist across process restarts.

```ts
import { MemoryTokenStore } from "@indev42/connections/stores/memory";

const store = new MemoryTokenStore();
```

Options:

- `encryption`: optional `TokenEncryption` implementation.
- `storeName`: optional name passed to encryption context. Defaults to `"memory"`.

### NeonTokenStore

`NeonTokenStore` persists serialized token payloads in Postgres-compatible storage.

```ts
import { NeonTokenStore } from "@indev42/connections/stores/neon";

const store = new NeonTokenStore({
  sql: postgresClient,
  schemaName: "integrations",
  tableName: "oauth_tokens",
  ensureSchema: true,
});
```

The `sql` client must expose this shape:

```ts
type NeonSqlClient = {
  query<Row extends object = Record<string, unknown>>(
    query: string,
    params?: unknown[],
  ): Promise<Row[] | { rows: Row[] }>;
};
```

Options:

- `sql`: required SQL client.
- `schemaName`: optional schema name.
- `tableName`: table name. Defaults to `"oauth_tokens"`.
- `encryption`: optional `TokenEncryption` implementation.
- `ensureSchema`: set to `false` if you manage schema creation yourself. Defaults to creating the schema/table on first use.

## Token Encryption

Stores serialize tokens through a `TokenEncryption` implementation. If none is provided, tokens are stored as plaintext JSON.

```ts
import { MemoryTokenStore, type TokenEncryption } from "@indev42/connections";

const encryption: TokenEncryption = {
  async encrypt({ plaintext, context }) {
    return encryptForStorage(plaintext, context.key);
  },
  async decrypt({ ciphertext, context }) {
    return decryptFromStorage(ciphertext, context.key);
  },
};

const store = new MemoryTokenStore({ encryption });
```

The encryption context includes the `TokenKey` and optional store name.

## Custom Providers

Implement `OAuthProvider` when adding a new OAuth service:

```ts
import type { OAuthProvider, TokenRecord } from "@indev42/connections";

class ExampleProvider implements OAuthProvider {
  readonly provider = "example";

  getAuthorizationUrl(input: {
    redirectUri: string;
    scopes?: string[];
    state?: string;
    metadata?: Record<string, unknown>;
  }): string {
    return "https://example.com/oauth/authorize";
  }

  async exchangeCode(input: {
    code: string;
    redirectUri?: string;
    metadata?: Record<string, unknown>;
  }): Promise<TokenRecord> {
    return { accessToken: "access-token" };
  }

  async refreshToken(input: {
    refreshToken: string;
    currentToken?: TokenRecord;
    metadata?: Record<string, unknown>;
  }): Promise<TokenRecord> {
    return { accessToken: "new-access-token" };
  }
}
```

Provider methods receive OAuth request data and optional metadata. They do not receive the app's `TokenKey`; key ownership stays inside `TokenManager` and `TokenStore`.

## Custom Stores

Implement `TokenStore` to persist tokens somewhere else:

```ts
import type { TokenKey, TokenRecord, TokenStore } from "@indev42/connections";

class CustomTokenStore implements TokenStore {
  readonly storeName = "custom";

  async get(key: TokenKey): Promise<TokenRecord | null> {
    return null;
  }

  async put(key: TokenKey, token: TokenRecord): Promise<void> {
    // Persist token.
  }

  async delete(key: TokenKey): Promise<void> {
    // Delete token.
  }
}
```

Use `serializeTokenRecordForStorage`, `deserializeTokenRecordFromStorage`, and `serializeTokenKey` from `@indev42/connections/core` if you want custom stores to share the same serialization and encryption behavior as the built-in stores.

## Development

Run tests:

```sh
bun run test
```

Run TypeScript checks:

```sh
bunx tsc --noEmit
```
