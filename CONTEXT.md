# Connections Context

This document defines the domain language used by `@indev42/connections`. It describes current semantics, not proposed APIs or provider-specific behavior.

## Connection

A **connection** is a locally managed credential relationship with an external service. A connection is identified by a `TokenKey` and represented by a stored `TokenRecord`.

Connections are local records. Their existence does not guarantee that the external service still accepts the associated credential.

## Token Key

A **token key** identifies one connection through three values:

- `provider`: the external service or integration namespace.
- `accountId`: the application-defined user, tenant, workspace, or external account associated with the connection.
- `connectionId`: an optional application-defined discriminator for multiple connections to the same provider and account.

The package treats the complete tuple of these values as the connection identity. It does not interpret or validate their meaning with the external service.

## Provider

A **provider** is an adapter for a service's OAuth behavior. An `OAuthProvider` creates authorization URLs, exchanges authorization codes, refreshes tokens, and may revoke tokens remotely.

The `provider` value in a token key also acts as the namespace used to select this adapter. A connection may be stored without a registered provider, but OAuth operations and token refresh require one.

## Token Record

A **token record** is the credential data stored for a connection. It contains an access token and may contain a refresh token, expiration time, token type, scopes, and provider-specific metadata.

The package validates the shape of token records but does not inspect token contents or verify them with the external service.

## Access Token

An **access token** is the credential returned to the application for authenticating requests to an external service. This term includes opaque credentials such as API tokens when they are managed as token records, even if the external service does not use OAuth.

## Refreshable Token

A **refreshable token** is a token record with a known expiration and a refresh token that can be passed to a registered OAuth provider. When the expiration is within the manager's refresh window, the manager refreshes and persists the token before returning it.

Having a refresh token does not by itself trigger refresh. Refresh is based on `expiresAt`.

## Static Token

A **static token** is a manually provisioned credential that this package stores and returns but does not acquire or rotate through OAuth. Static tokens can be saved with `saveInitialToken` without registering an OAuth provider.

For current behavior, a static token should omit `expiresAt`. The manager then treats it as valid until it is replaced or deleted. This means only that the package has no expiration time to act on; it does not guarantee that the credential never expires, is not revoked, or remains accepted by the external service.

An expiring token without a refresh token is not a separately supported lifecycle. Once it enters the refresh window, retrieval fails because the manager cannot refresh it.

The term **read-only token** is avoided because it commonly describes authorization scope rather than credential lifecycle. A static token may permit read, write, or other operations according to the external service.

## Valid Token

A **valid token**, in manager API names such as `getValidToken`, means a stored token that is not within its known refresh window, or one that the manager successfully refreshed. The package does not make a request to the external service to prove that the token is accepted.

A token without `expiresAt` is therefore treated as valid based on local information alone.

## Revocation And Deletion

**Revocation** invalidates a credential with the external service when the registered provider supports remote revocation. **Deletion** removes the connection's token record from the local store.

`TokenManager.revoke` attempts supported remote revocation first and then deletes the local record. If no provider or remote revocation method is available, it only deletes the local record.

Deleting a connection does not otherwise guarantee that its credential is invalidated externally.

## Token Store

A **token store** persists token records by token key. Stores support reading, writing, and deleting records. "Static token" describes token lifecycle and does not mean that the underlying store is read-only.
