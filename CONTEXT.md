# Connections Context

This document defines the domain language used by `@indev42/connections`. It describes current semantics, not proposed APIs or provider-specific behavior.

## Connection

A **connection** is a credential relationship with an external service managed through a provider binding. A connection is identified by a `TokenKey` and represented at runtime by a `TokenRecord`.

A connection may be persisted as a local token record or derived from an externally managed credential source. Its existence does not guarantee that the external service still accepts the associated credential.

## Token Key

A **token key** identifies one connection through three values:

- `provider`: the external service or integration namespace.
- `accountId`: the application-defined user, tenant, workspace, or external account associated with the connection.
- `connectionId`: an optional application-defined discriminator for multiple connections to the same provider and account.

The package treats the complete tuple of these values as the connection identity. It does not interpret or validate their meaning with the external service.

## Provider

A **provider** is an adapter for a service's credential behavior. An `OAuthProvider` creates authorization URLs, exchanges authorization codes, refreshes tokens, and may revoke tokens remotely. A `StaticTokenProvider` converts a manually provisioned credential into the service's static token record.

The `provider` value in a token key also acts as its service namespace and selects a registered provider binding. Every manager operation requires a matching binding. OAuth bindings use a writable token store. Static bindings use either a token store or a read-only credential source.

## Provider Binding

A **provider binding** associates a service adapter with the storage boundary used for that provider. Bindings allow providers to use separate stores or share the same store. The binding registered under a provider name must contain an adapter with that same name.

## Token Record

A **token record** is the normalized credential data used by the manager and persisted by token stores. It contains an access token and may contain a refresh token, expiration time, lifecycle, token type, scopes, and provider-specific metadata.

The package validates the shape of token records but does not inspect token contents or verify them with the external service.

## Access Token

An **access token** is the credential returned to the application for authenticating requests to an external service. This term includes opaque credentials such as API tokens when they are managed as token records, even if the external service does not use OAuth.

## Refreshable Token

A **refreshable token** is a token record with `lifecycle: "refreshable"`, a known expiration, and a refresh token that can be passed to a registered OAuth provider. When the expiration is within the manager's refresh window, the manager refreshes and persists the token before returning it.

Having a refresh token does not by itself trigger refresh. Refresh is based on `expiresAt`.

## Static Token

A **static token** is a manually provisioned credential that this package does not acquire or rotate through OAuth. A stored static binding can persist a normalized record with `saveToken` or normalize and persist a raw credential with `saveCredential`. A sourced static binding normalizes its raw credential in memory on each load.

When a static token has no `expiresAt`, the manager treats it as valid until it is replaced or deleted. This means only that the package has no expiration time to act on; it does not guarantee that the credential never expires, is not revoked, or remains accepted by the external service.

When a static token has an `expiresAt`, it remains valid until that exact time and does not use the refresh window. Once expired, retrieval fails with `TokenExpiredError`. Static token records cannot contain a refresh token.

The term **read-only token** is avoided because it commonly describes authorization scope rather than credential lifecycle. A static token may permit read, write, or other operations according to the external service.

## Valid Token

A **valid token**, in manager API names such as `getValidToken`, means a refreshable token that is not within its known refresh window or was successfully refreshed, or a static token that has not reached its known expiration. The package does not make a request to the external service to prove that the token is accepted.

A token without `expiresAt` is therefore treated as valid based on local information alone.

## Legacy Lifecycle

The lifecycle field is optional for compatibility with existing token records and OAuth providers. For OAuth bindings, when `lifecycle` is omitted, `expiresAt` determines whether to refresh and an expiring token without a refresh token cannot be refreshed. Static bindings never refresh, even when a stored legacy record omits `lifecycle`.

## Revocation And Deletion

**Revocation** invalidates a credential with the external service when the registered provider supports remote revocation. **Deletion** removes the connection's token record from the local store.

For OAuth bindings, `TokenManager.revoke` attempts supported remote revocation first and then deletes the local record. For stored static bindings, it deletes the local record. Revocation is unsupported for source-backed bindings because the manager cannot mutate an externally managed credential source.

Deleting a connection does not otherwise guarantee that its credential is invalidated externally.

## Token Store

A **token store** persists token records by token key. Stores support reading, writing, and deleting records. "Static token" describes token lifecycle and does not mean that the underlying store is read-only.

## Credential Source

A **credential source** reads an externally managed, provider-specific raw credential. Sources do not return token records and do not support writes or deletion. A static provider converts a source value into a normalized token record before the manager returns it. Environment variables and external secret configuration are credential sources rather than token stores.
