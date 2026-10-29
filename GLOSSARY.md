# Connections glossary

Agreed vocabulary for application connections to external systems. See [Domain guidance](docs/agents/domain.md) for terminology practice, definition approval, and maintenance.

## Language

**Connection**:
An identifiable relationship through which an application accesses an external system. Its identity can remain stable when credentials refresh, rotate, expire, or are revoked.
_Avoid_: using connection as a synonym for token or stored credential record.

**Provider**:
The external system a connection gives access to, such as Salesforce, Shopify, or Zoho.
_Avoid_: service when it could be confused with an Effect service.

**Credential**:
Material presented to prove identity or authority, or to obtain further credentials. API keys, client secrets, access tokens, and refresh tokens are specific kinds of credentials.
_Avoid_: token as an umbrella for all credentials.

**Source credential**:
A credential retained so that Connections can obtain a derived credential without interactive authorization. Replacing it changes the durable basis for future acquisition.
_Avoid_: refresh token when the provider instead permits repeated use of the same client credential.

**Derived credential**:
A credential obtained from a source credential for protected-resource use. It may expire or be rejected while the source credential remains usable.
_Avoid_: treating rejection or expiry of a derived credential as proof that its source credential is invalid.

## Distinctions

- Application credentials, such as an OAuth client secret, are distinct from credentials associated with a particular connection. One application registration can support many connections.
- An OAuth authorization server issues tokens; a resource server handles protected-resource requests. A provider may encompass both, but they need not be the same system.
- OAuth 2.0 is an authorization framework; authorization code and client credentials are grant types; an API key is a credential type.
- An authorization attempt is one execution of an authorization flow, potentially failing, expiring, or being abandoned. It is not a blanket term for token refresh or API-key configuration.
- Removing local authorization and revoking authorization at a provider are distinct actions.
- Ownership belongs to the consuming application's domain. An owner is not necessarily a user.
- A provider-specific shop, organization, installation, or account is not necessarily a universal external-account concept. One credential can grant access to multiple resources.
