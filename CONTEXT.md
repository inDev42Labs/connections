# Connections domain

This vocabulary describes connections to external systems. It does not prescribe Effect services, storage schemas, or the public interface.

## Core terms

**Connection**: An identifiable relationship through which an application accesses an external system. Its identity can remain stable when credentials refresh, rotate, expire, or are revoked; it need not correspond to a database record.
_Avoid_: using connection as a synonym for token or stored credential record.

**Provider**: The external system a connection gives access to, such as Salesforce, Shopify, or Zoho. A provider definition is code describing how the library works with that system, not the external system itself.
_Avoid_: service when it could be confused with an Effect service.

**Credential**: Material presented to prove identity or authority, or to obtain further credentials. API keys, client secrets, access tokens, and refresh tokens are specific kinds of credentials; use their specific names when their differences matter.
_Avoid_: token as an umbrella for all credentials.

**Source credential**: A credential retained so that Connections can obtain a derived credential without interactive authorization. A client secret is a source credential; replacing it changes the durable basis for future acquisition.
_Avoid_: refresh token when the provider instead permits repeated use of the same client credential.

**Derived credential**: A credential obtained from a source credential and returned for protected-resource use. An access token issued through a client credentials grant is a derived credential; it may expire or be rejected while the source credential remains usable.
_Avoid_: treating rejection or expiry of a derived credential as proof that its source credential is invalid.

## Distinctions to preserve

- Application credentials, such as an OAuth client secret, are distinct from credentials associated with a particular connection. One application registration can support many connections; the exact relationship depends on the auth mechanism.
- An OAuth authorization server issues tokens; a resource server handles protected resource requests. A provider may encompass both, but they need not be the same system.
- OAuth 2.0 is an authorization framework; authorization code and client credentials are grant types; an API key is a credential type. A generic auth-method abstraction has not been agreed.
- An authorization attempt is one execution of an authorization flow, potentially failing, expiring, or being abandoned. Do not use it as a blanket term for token refresh or API-key configuration.
- Removing locally stored authorization and revoking authorization at a provider are distinct actions. `remove(id)` removes local authorization only. See [security and ownership](docs/reference.md#security-and-ownership).
- Ownership belongs to the consuming application's domain. An owner is not necessarily a user, and a required library-level owner model has not been agreed.
- A provider-specific shop, organization, installation, or account is not necessarily a universal external-account concept. One credential can grant access to multiple resources.

## Technical vocabulary, not domain entities

Configuration helpers, stores, encryptors, vaults, adapters, Effect services, and layers describe implementation mechanisms. Their names and interfaces remain design choices. In particular, a vault abstraction has not been selected.

"Access" remains an informal description, not a distinct domain entity or public type. The credential-first target is described in the authoritative [consumer guide](docs/getting-started.md) and constrained by `PR-002` in [CONSTITUTION.md](CONSTITUTION.md).
