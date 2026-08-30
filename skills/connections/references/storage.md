# Storage and encryption

Choose storage from deployment durability and concurrency requirements. A store may be shared across bindings because the full `TokenKey` includes the provider namespace.

## Memory

`MemoryTokenStore` is process-local. Use it for tests, local development, demos, and intentionally short-lived processes.

```ts
import { MemoryTokenStore } from "@indev42/connections/stores/memory";

const store = new MemoryTokenStore({ encryption });
```

It does not share data across instances and loses data on restart.

## Neon or Postgres-compatible SQL

Provide a client with `query(sql, params)` returning either an array of rows or `{ rows }`:

```ts
import { NeonTokenStore } from "@indev42/connections/stores/neon";

const store = new NeonTokenStore({
  sql,
  schemaName: "integrations",
  tableName: "oauth_tokens",
  encryption,
});
```

The store creates its schema/table lazily by default. Set `ensureSchema: false` only when migrations create the matching table before runtime. Schema and table names may contain letters, numbers, and underscores and must start with a letter or underscore.

## Convex

The application owns the Convex schema and functions. Pass generated function references into the store:

```ts
import { ConvexTokenStore } from "@indev42/connections/stores/convex";

const store = new ConvexTokenStore({
  client,
  functions: {
    get: api.oauthTokens.get,
    put: api.oauthTokens.put,
    delete: api.oauthTokens.remove,
  },
  encryption,
});
```

Read the installed package's Convex store README for the required `tokenKey`, `provider`, `accountId`, `connectionId`, and `tokenData` schema and function contracts. The package intentionally does not import Convex.

## AES-GCM encryption

Without `encryption`, built-in stores persist plaintext JSON. For credential-bearing durable stores, configure encryption unless an explicitly reviewed storage layer already provides the required application-level protection.

```ts
import { AesGcmTokenEncryption } from "@indev42/connections/encryptors/aes-gcm";

const encryption = new AesGcmTokenEncryption({
  key: process.env.TOKEN_ENCRYPTION_KEY!,
});
```

String keys default to base64url. The decoded key must be 16, 24, or 32 bytes; use 32 random bytes for AES-256. Set `keyEncoding: "base64"` when loading a base64 key. Keep this key separate from OAuth client secrets and token data.

Ciphertext is authenticated against `provider`, `accountId`, `connectionId`, and `storeName`. Moving ciphertext to another key or store context causes decryption to fail. Renaming a provider or changing store context therefore requires decrypting with the old context and rewriting under the new context.

The built-in encryptor has one active key. Rotate by reading each record with the old key and writing it with the new key, or provide an application-owned `TokenEncryption` wrapper that supports fallback decryption.

## Verify

For durable stores, integration-test put/get/delete against the actual client contract. Confirm persisted `tokenData` is not parseable as the original token JSON when encryption is enabled, and confirm wrong-key or wrong-context decryption fails without overwriting the existing record.