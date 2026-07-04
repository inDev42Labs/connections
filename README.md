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

## Providers

Providers implement OAuth service-specific behavior: authorization URLs, code exchange, token refresh, and optional token revocation.

| Provider | Import | Purpose |
| --- | --- | --- |
| Dummy | `@indev42/connections/providers/dummy` | Network-free provider for examples, demos, tests, and local sampling. |
| Salesforce | `@indev42/connections/providers/salesforce` | Salesforce OAuth provider with production, sandbox, and custom login URL support. |
| Zoho | `@indev42/connections/providers/zoho` | Zoho OAuth provider with data center and accounts URL support. |

Built-in providers are also exported from the root package entrypoint:

```ts
import {
  DummyOAuthProvider,
  SalesforceOAuthProvider,
  ZohoOAuthProvider,
} from "@indev42/connections";
```

More detailed provider usage can live in colocated provider README files under `src/providers/<provider>/README.md`.

## Stores

Stores implement token persistence. All built-in stores use the shared token serialization and optional `TokenEncryption` flow.

| Store | Import | Purpose |
| --- | --- | --- |
| Memory | `@indev42/connections/stores/memory` | In-memory token storage for tests, local development, and short-lived processes. |
| Neon | `@indev42/connections/stores/neon` | Postgres-compatible token storage using a Neon-style or pg-style SQL client. |
| Convex | `@indev42/connections/stores/convex` | Convex-backed token storage using app-provided Convex query and mutation function references. |

Built-in stores are also exported from the root package entrypoint:

```ts
import {
  ConvexTokenStore,
  MemoryTokenStore,
  NeonTokenStore,
} from "@indev42/connections";
```

Store-specific setup details can live in colocated store README files under `src/stores/<store>/README.md`. The Convex store includes `src/stores/convex/README.md` because it requires app-owned Convex schema and functions.

## Token Encryption

Stores serialize tokens through a `TokenEncryption` implementation. If none is provided, tokens are stored as plaintext JSON.

Built-in encryptors:

| Encryptor | Import | Purpose |
| --- | --- | --- |
| AES-GCM | `@indev42/connections/encryptors/aes-gcm` | Web Crypto AES-GCM encryption for production token storage. |

Built-in encryptors are also exported from the root package entrypoint:

```ts
import { AesGcmTokenEncryption } from "@indev42/connections";
```

Use `AesGcmTokenEncryption` with any store that accepts `encryption`:

```ts
import { AesGcmTokenEncryption, MemoryTokenStore } from "@indev42/connections";

const encryption = new AesGcmTokenEncryption({
  key: process.env.TOKEN_ENCRYPTION_KEY!,
});

const store = new MemoryTokenStore({ encryption });
```

The AES-GCM key must be 16, 24, or 32 bytes. String keys default to base64url encoding. Use 32 random bytes for AES-256 in production.

More detailed setup notes live in `src/encryptors/aes-gcm/README.md`.

You can also provide a custom encryptor:

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
