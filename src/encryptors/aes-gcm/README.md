# AES-GCM Token Encryption

`AesGcmTokenEncryption` encrypts serialized OAuth token records with Web Crypto AES-GCM before a token store persists them.

The encryptor is store-agnostic. Use it with any built-in or custom store that accepts a `TokenEncryption` implementation.

## Setup

```ts
import { AesGcmTokenEncryption } from "@indev42/connections/encryptors/aes-gcm";
import { NeonTokenStore } from "@indev42/connections/stores/neon";

const encryption = new AesGcmTokenEncryption({
  key: process.env.TOKEN_ENCRYPTION_KEY!,
});

const store = new NeonTokenStore({
  sql,
  encryption,
});
```

`AesGcmTokenEncryption` is also exported from the root package entrypoint:

```ts
import { AesGcmTokenEncryption } from "@indev42/connections";
```

## Keys

The AES key must be 16, 24, or 32 bytes. Use 32 random bytes for AES-256 in production.

String keys default to base64url encoding:

```ts
const encryption = new AesGcmTokenEncryption({
  key: process.env.TOKEN_ENCRYPTION_KEY!,
});
```

Base64 strings are supported by setting `keyEncoding`:

```ts
const encryption = new AesGcmTokenEncryption({
  key: process.env.TOKEN_ENCRYPTION_KEY!,
  keyEncoding: "base64",
});
```

Raw bytes and Web Crypto keys are also supported:

```ts
const encryption = new AesGcmTokenEncryption({
  key: new Uint8Array(32),
});
```

## Generate A Key

Generate a base64url AES-256 key with Bun:

```sh
bun -e 'console.log(Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url"))'
```

Generate a base64 AES-256 key with Node:

```sh
node -e 'console.log(require("crypto").randomBytes(32).toString("base64"))'
```

Use the matching `keyEncoding` when loading the key.

## Context Binding

The encryptor authenticates each ciphertext with the token encryption context. That context includes `provider`, `accountId`, `connectionId`, and `storeName`.

If ciphertext is copied to a different token key or store context, decryption fails.

## Ciphertext Format

Stored values use a versioned string format:

```txt
v1.<base64url-iv>.<base64url-ciphertext-and-tag>
```

The IV is generated randomly for every encryption operation.

## Runtime Requirements

`AesGcmTokenEncryption` requires Web Crypto support through `globalThis.crypto.subtle`. This is available in modern Node.js, Bun, browsers, and many serverless runtimes.

## Key Rotation

This encryptor uses one active key. To rotate keys, read each stored token with the old key and write it back with the new key.

Applications that need transparent multi-key rotation can wrap `TokenEncryption` with app-owned fallback decrypt logic.
