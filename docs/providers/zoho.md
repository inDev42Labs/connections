# Zoho

Zoho supports browser OAuth and Self Client enrollment. See the [provider catalog](../reference.md#providers) for other providers and the [getting-started guide](../getting-started.md) for common setup and credential workflows.

## Browser OAuth

Use `Zoho.oauth(...)` for browser authorization. Choose the appropriate accounts region and scopes. Follow the common [browser OAuth workflow](../getting-started.md#connect-through-browser-oauth) for authorization start and callback completion.

## Renewal failures

For both mechanisms, refresh error `invalid_code` reports `AuthorizationRequired`. [Zoho's refresh-token error guidance](https://www.zoho.com/books/api/v3/oauth/#step4) distinguishes deleted or revoked refresh tokens from app-authentication errors. HTTP outages, throttling, `invalid_client`, `invalid_client_secret`, and `access_denied` report `TemporarilyUnavailable`, not proof that the saved authorization was revoked. The adapter also recognizes JSON error responses returned with HTTP 200.

Connections retains those remote failures without assuming replay safety. A later read returns the retained failure unless recovery evidence exists. Repairing a proven pre-dispatch configuration failure permits a new acquisition on a later read. Lost transport responses and malformed successful responses require intervention. See [retrieval failures](../reference.md#handle-retrieval-failures). Local substitutes verify classification, not live Zoho behavior.

## Self Client enrollment

Zoho Self Client does not have the browser start/callback sequence. Call `enrollCode(id, { code, authorize })` with a short-lived code, or include `{ replace: true }` to replace saved authorization. The `authorize` callback takes no arguments; your application checks permission for the ID it supplied before exchange. A denied callback prevents exchange. Use `credentials(id)` for subsequent reads. Do not treat Self Client enrollment as a browser OAuth callback.
