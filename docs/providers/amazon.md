# Amazon

Use `Amazon.oauth` for server-side [Login with Amazon (LWA) authorization-code grants](https://developer.amazon.com/docs/login-with-amazon/authorization-code-grant.html). Connections obtains, encrypts, and renews credentials. Your application makes Amazon API requests with the returned access token.

Scopes are configurable, not restricted to advertising. Amazon APIs that document support for this LWA flow and its tokens can use the provider, subject to their app registration, approval, and permission requirements. Sharing LWA does not make authorizations interchangeable: an Amazon Ads grant does not automatically authorize Selling Partner API access, and this provider does not implement a separate service's enrollment flow.

## Configure authorization

Register an LWA security profile and add your complete HTTPS callback URL to its Allowed Return URLs. Supply the client ID, client secret, redirect URI, and scopes. Amazon Ads also requires [Ads API access approval and the appropriate scopes](https://advertising.amazon.com/API/docs/en-us/guides/account-management/authorization/authorization-grants); ordinary Login with Amazon registration alone does not grant advertising access.

Given a configured `store`, create the manager on your server:

```ts
import { Connections } from '@indev42/connections'
import { Amazon } from '@indev42/connections/providers/amazon'

const clientId = process.env.AMAZON_CLIENT_ID!
const amazon = Connections.create({
  store,
  provider: Amazon.oauth({
    clientId,
    clientSecret: () => process.env.AMAZON_CLIENT_SECRET!,
    redirectUri: 'https://example.com/oauth/amazon/callback',
    scopes: ['advertising::campaign_management'],
    region: 'na',
  }),
})
```

Use the existing [browser OAuth workflow](../getting-started.md#connect-through-browser-oauth): authenticate the caller, check setup permission, start authorization with a trusted session binding, and complete the callback with an application permission check. Connections supplies OAuth state and PKCE using S256, exchanges the authorization code on the server, and stores the refresh token encrypted. There is no manual refresh-token import operation.

`clientId` and `redirectUri` accept strings, callbacks returning strings, or Effects. `clientSecret` accepts a string, a callback returning a string, or an Effect returning a redacted string. Configuration is resolved when needed, not when the provider is constructed. `scopes` must be a non-empty tuple; use the scopes documented by the Amazon API you intend to call. For ordinary LWA profile access, for example, use `['profile']` rather than the advertising scope.

## Choose an authorization region

`region` defaults to `'na'`. It selects Amazon's [regional authorization and token endpoints](https://advertising.amazon.com/API/docs/en-us/guides/account-management/authorization/authorization-grants):

| Region | Authorization URL | Token URL |
| --- | --- | --- |
| `'na'` | `https://www.amazon.com/ap/oa` | `https://api.amazon.com/auth/o2/token` |
| `'eu'` | `https://eu.account.amazon.com/ap/oa` | `https://api.amazon.co.uk/auth/o2/token` |
| `'fe'` | `https://apac.account.amazon.com/ap/oa` | `https://api.amazon.co.jp/auth/o2/token` |

The same token endpoint handles code exchange and refresh. Selecting an authorization region does not discover advertising profiles or select the regional Ads API endpoint for your application.

## Use advertising credentials

One connection represents one authorization grant, not one seller, marketplace, or advertising profile. A grant can permit access to multiple profiles. Your application discovers those profiles and selects the profile and regional API endpoint for each request.

After checking the caller's permission, retrieve `{ accessToken }`. No refresh token or client secret is returned. For example, this application-owned request lists profiles in the North America Ads API region:

```ts
import { revealSecret } from '@indev42/connections'

await requireConnectionAccess(currentUser, connectionId) // your application's check
const { accessToken } = await amazon.credentials(connectionId)
const response = await fetch('https://advertising-api.amazon.com/v2/profiles', {
  headers: {
    Authorization: `Bearer ${revealSecret(accessToken)}`,
    'Amazon-Advertising-API-ClientId': clientId,
  },
})
```

For profile-scoped operations, your application also supplies the selected profile ID in `Amazon-Advertising-API-Scope`. Reports, campaign changes, keyword management, regional routing, and API-specific permissions remain in your application or SDK. Consult Amazon's [Ads API documentation](https://advertising.amazon.com/API/docs/en-us) for those operations.

## Understand renewal failures

Connections uses Amazon's `expires_in` value rather than inventing a token lifetime. Renewal retains the previous refresh token when Amazon omits one and saves a replacement when Amazon returns one.

A refresh HTTP 400 or 401 carrying OAuth `invalid_grant` requires authorization again. Client authentication failures such as `invalid_client`, throttling, and server errors return `TemporarilyUnavailable`, not proof that the connection grant was revoked. Connections retains those remote failures rather than assuming refresh replay is safe. A repaired configuration failure proven to precede dispatch permits a fresh acquisition on a later read. Lost responses and malformed successful refresh responses require intervention. See [retrieval failures](../reference.md#handle-retrieval-failures) and Amazon's [token request, response, and refresh documentation](https://developer.amazon.com/docs/login-with-amazon/authorization-code-grant.html).

Use `credentialUse(id).reportRejected()` only for a confirmed rejection of that specific access token, not for missing advertising permissions or an incorrect profile. `remove(id)` deletes local authorization; it does not revoke authorization at Amazon.

Local tests exercise the public manager with simulated Amazon responses and verify package consumption. They do not establish live Amazon account access. Compatibility with downstream Amazon APIs follows Amazon's documented LWA support; individual API operations are not tested by Connections.
