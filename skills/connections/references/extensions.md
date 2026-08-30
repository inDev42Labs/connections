# Extension interfaces

Extend the package at its interfaces instead of duplicating `TokenManager` behavior.

## OAuth provider

Implement `OAuthProvider` for service-specific authorization, exchange, refresh, and optional revocation:

```ts
import type {
  AuthorizationUrlInput,
  ExchangeCodeInput,
  OAuthProvider,
  RefreshTokenInput,
  RevokeTokenInput,
  TokenRecord,
} from "@indev42/connections";

export class ExampleOAuthProvider implements OAuthProvider {
  getAuthorizationUrl(input: AuthorizationUrlInput): string {
    // Construct a URL from redirectUri, scopes, state, and provider config.
    return "https://provider.example/authorize";
  }

  async exchangeCode(input: ExchangeCodeInput): Promise<TokenRecord> {
    // Exchange input.code and normalize the response.
    return {
      accessToken: "...",
      refreshToken: "...",
      expiresAt: Date.now() + 3_600_000,
      lifecycle: "refreshable",
    };
  }

  async refreshToken(input: RefreshTokenInput): Promise<TokenRecord> {
    // Use input.refreshToken. The manager merges omitted non-refresh fields.
    return { accessToken: "...", expiresAt: Date.now() + 3_600_000 };
  }

  async revokeToken(input: RevokeTokenInput): Promise<void> {
    // Revoke with the external service when supported.
  }
}
```

Use the exact exported input types from the installed package when inference is insufficient. Validate HTTP status and provider error payloads before returning. Throw a sanitized `OAuthProviderError`; never include credentials, codes, tokens, or response bodies in its message/details. Return epoch milliseconds, not `expires_in` seconds.

## Static provider

Implement `StaticTokenProvider<TCredential>` to normalize a raw provider-specific credential:

```ts
import type { StaticTokenProvider, TokenRecord } from "@indev42/connections";

type ExampleCredential = { apiKey: string; expiresAt?: number };

export class ExampleStaticProvider
  implements StaticTokenProvider<ExampleCredential>
{
  createToken(credential: ExampleCredential): TokenRecord {
    return {
      accessToken: credential.apiKey,
      expiresAt: credential.expiresAt,
      lifecycle: "static",
      tokenType: "Bearer",
    };
  }
}
```

Reject empty or malformed raw credentials before returning. Static records cannot contain a refresh token.

## Token store

Implement `TokenStore` with `get`, `put`, and `delete` keyed by the complete `TokenKey`. Give it a stable `storeName` when encryption context must distinguish stores.

Use `serializeTokenKey`, `serializeTokenRecordForStorage`, and `deserializeTokenRecordFromStorage` from `@indev42/connections/core` to preserve built-in validation and encryption semantics. Serialize before mutating durable state so encryption failure cannot partially overwrite a record.

## Credential source

Implement `CredentialSource<TCredential>` for externally owned, read-only credentials. Return the raw provider-specific credential or `null`; let the static provider normalize it. Do not cache secrets unless the source's rotation and invalidation contract explicitly permits caching.

## Token encryption

Implement `TokenEncryption` when integrating a KMS or envelope-encryption system. Authenticate or otherwise bind ciphertext to the provided context so records cannot be silently moved across token keys. Preserve a version or key identifier in ciphertext when supporting rotation.

## Verify

Contract-test every extension for valid output, malformed remote/input data, secret-safe failures, and complete-key isolation. For OAuth adapters, also test refresh responses that omit a replacement refresh token. For stores and encryptors, test serialization or encryption failure before persistence and decryption failure during reads.