# @indev42/connections

Token management for app integrations using OAuth or manually provisioned static credentials. This package provides a small core `TokenManager`, provider adapters, token stores, credential sources, and optional encryption.

See [`CONTEXT.md`](./CONTEXT.md) for the domain language used for connections, providers, and token lifecycles.

## Quickstart

Install the package:

```sh
bun add @indev42/connections
```

Create a manager with a provider binding. Each provider has its own store:

```ts
import {
  MemoryTokenStore,
  TokenManager,
  ZohoOAuthProvider,
} from "@indev42/connections";

const zoho = new ZohoOAuthProvider({
  credentials: {
    clientId: process.env.ZOHO_CLIENT_ID!,
    clientSecret: process.env.ZOHO_CLIENT_SECRET!,
  },
  defaultScopes: ["ZohoCRM.modules.READ"],
  accessType: "offline",
  prompt: "consent",
});

const manager = new TokenManager({
  providers: {
    zoho: {
      adapter: zoho,
      store: new MemoryTokenStore(),
    },
  },
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

Use a valid access token later. The manager refreshes refreshable tokens automatically when they enter the refresh window:

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

`TokenManager` coordinates provider bindings. It selects a binding by `key.provider`, uses that binding's store or credential source, returns valid access tokens, refreshes OAuth tokens, deduplicates concurrent refreshes for the same token key, and handles supported persistence and revocation operations.

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
  lifecycle?: "refreshable" | "static";
  tokenType?: string;
  scopes?: string[];
  metadata?: Record<string, unknown>;
};
```

`expiresAt` is an epoch millisecond timestamp. Explicitly refreshable tokens require both `expiresAt` and `refreshToken`. Static tokens may include `expiresAt`, but they never refresh. Tokens without `expiresAt` are treated as valid from local information until replaced or deleted.

The package validates this shape at provider, manager, serialization, and storage boundaries. `accessToken` and any present `refreshToken` must be non-empty strings. A static token cannot contain a refresh token, while an explicitly refreshable token requires a refresh token and expiration. Malformed records throw `InvalidTokenRecordError` with code `INVALID_TOKEN_RECORD` before they can be persisted or returned.

### Static Tokens

Bind a static provider to a standard store when the application should manage the token record:

```ts
import {
  bindStaticProvider,
  EnvironmentCredentialSource,
  MemoryTokenStore,
  RetellAIProvider,
  TokenManager,
} from "@indev42/connections";

const retell = new RetellAIProvider();
const store = new MemoryTokenStore();
const manager = new TokenManager({
  providers: {
    retell: bindStaticProvider(retell, { store }),
  },
});

const staticKey = { provider: "retell", accountId: "tenant-1" };

await manager.saveCredential({
  key: staticKey,
  credential: process.env.RETELL_API_KEY!,
});

const accessToken = await manager.getValidAccessToken(staticKey);
```

A static token can include `expiresAt`. It remains valid until that exact time, regardless of `refreshSkewMs`, and then retrieval throws `TokenExpiredError` with code `TOKEN_EXPIRED`. Static bindings never refresh. `saveToken` can persist an already normalized record, while `saveCredential` asks the static provider to normalize a raw credential before persistence. `saveInitialToken` remains available as a deprecated compatibility alias for `saveToken`.

Use a credential source when a raw credential is managed outside this package. Environment variables contain only the raw value:

```ts
const manager = new TokenManager({
  providers: {
    retell: bindStaticProvider(new RetellAIProvider(), {
      source: new EnvironmentCredentialSource({
        key: "RETELL_API_KEY",
        runtimeEnv: process.env,
      }),
    }),
  },
});

const apiKey = await manager.getValidAccessToken({
  provider: "retell",
  accountId: "workspace-id",
});
```

The source returns the raw string and `RetellAIProvider` converts it to a static bearer `TokenRecord` in memory. Source-backed bindings are read-only: `saveToken`, `saveCredential`, and `revoke` are not supported because the manager cannot mutate the external source.

## TokenManager Configuration

```ts
const manager = new TokenManager({
  providers: {
    zoho: { adapter: zohoProvider, store: zohoStore },
    salesforce: { adapter: salesforceProvider, store: salesforceStore },
  },
  refreshSkewMs: 60_000,
  onEvent: (event) => observability.record(event),
});
```

Options:

- `providers`: provider-name map of bindings. OAuth bindings require an adapter and store. Static bindings use either a store or credential source. The map key must equal `adapter.provider`.
- `refreshSkewMs`: how early to refresh expiring tokens. Defaults to `60_000`.
- `now`: optional clock override, mainly for tests.
- `onEvent`: optional structured callback for exchange, refresh, load, and persistence outcomes. Events contain sanitized diagnostics and never token values, authorization codes, client secrets, encrypted records, or response bodies. Callback failures are ignored so observability cannot interrupt token handling.

Common methods:

- `getAuthorizationUrl({ key, redirectUri, scopes, state, metadata })`
- `exchangeCodeAndSave({ key, code, redirectUri, metadata })`
- `saveCredential({ key, credential })`
- `saveToken({ key, token })`
- `saveInitialToken({ key, token })`
- `getValidToken(key, { metadata })`
- `getValidAccessToken(key, { metadata })`
- `revoke(key, { metadata })`

## Providers

Providers implement service-specific credential behavior. OAuth providers handle authorization URLs, code exchange, token refresh, and optional token revocation. Static token providers convert manually provisioned credentials into service-appropriate token records. Both are registered through provider bindings.

| Provider | Import | Purpose |
| --- | --- | --- |
| Dummy | `@indev42/connections/providers/dummy` | Network-free provider for examples, demos, tests, and local sampling. |
| Retell AI | `@indev42/connections/providers/retell` | Retell API key provider using a static bearer token. |
| Salesforce | `@indev42/connections/providers/salesforce` | Salesforce OAuth provider with production, sandbox, and custom login URL support. |
| Zoho | `@indev42/connections/providers/zoho` | Zoho OAuth provider with data center and accounts URL support. |

Built-in providers are also exported from the root package entrypoint:

```ts
import {
  DummyOAuthProvider,
  RetellAIProvider,
  SalesforceOAuthProvider,
  ZohoOAuthProvider,
} from "@indev42/connections";
```

More detailed provider usage can live in colocated provider README files under `src/providers/<provider>/README.md`.

## Stores

Stores implement token persistence. All built-in stores use the shared token serialization and optional `TokenEncryption` flow.

A store can be shared by multiple provider bindings or each provider can use a different store. Static and OAuth providers can both use standard stores.

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

## Credential Sources

A `CredentialSource<T>` reads an externally managed raw credential. Unlike a `TokenStore`, it is read-only and does not return normalized token records. A static provider converts the source value to a `TokenRecord` when the manager loads it.

`EnvironmentCredentialSource` supports a fixed environment key or a resolver based on `TokenKey`:

```ts
const source = new EnvironmentCredentialSource({
  runtimeEnv: process.env,
  key: (tokenKey) => `RETELL_API_KEY_${tokenKey.accountId}`,
});
```

Environment values are returned unchanged. Missing values are treated as missing tokens.

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

OAuth provider methods receive OAuth request data and optional metadata. They do not receive the app's `TokenKey`; key ownership stays inside `TokenManager` and the configured storage boundary.

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
