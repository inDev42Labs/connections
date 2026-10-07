# Salesforce

Salesforce supports browser OAuth and client credentials. See the [provider catalog](../reference.md#providers) for other providers and the [getting-started guide](../getting-started.md) for common setup and credential workflows.

## Browser OAuth

Use `Salesforce.oauth({ clientId, clientSecret, redirectUri, scopes })` for browser authorization. Use scopes that permit the provider operations and refresh you need. The [getting-started guide](../getting-started.md#connect-through-browser-oauth) shows the start and callback sequence with Salesforce.

## Client credentials

`Salesforce.clientCredentials({ loginUrl })` requires the org's My Domain origin, such as `https://example.my.salesforce.com`. It does not default to `login.salesforce.com`; the global login and test hosts are unsupported for this flow. Configure the app's client credentials flow, scopes, and Run As integration user in Salesforce. No redirect URI or browser callback is used. See [Salesforce's client credentials flow](https://help.salesforce.com/s/articleView?id=sf.remoteaccess_oauth_client_credentials_flow.htm&type=5).

Save `{ clientId, clientSecret }` with `setClientCredentials`. The secret accepts a string or redacted secret. Reads return `{ accessToken, instanceUrl }`, the same use shape as browser OAuth. Salesforce does not issue a refresh token for this grant; Connections retains the encrypted source to acquire another access token. If the response omits expiry, Connections does not invent a token lifetime. Report a confirmed rejection through `credentialUse(id).reportRejected()` to trigger reacquisition on the next read.

`loginUrl` accepts the same string, callback, or Effect configuration as browser OAuth. The optional `fetch` supplies a fetch implementation for local substitutes or consumer transport needs. Client credentials use the provider identity `salesforce-client-credentials`, distinct from browser OAuth's `salesforce`. Keep the My Domain configuration stable when reusing saved connections.
