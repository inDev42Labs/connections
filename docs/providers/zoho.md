# Zoho

Zoho supports browser OAuth and Self Client enrollment. See the [provider catalog](../reference.md#providers) for other providers and the [getting-started guide](../getting-started.md) for common setup and credential workflows.

## Browser OAuth

Use `Zoho.oauth(...)` for browser authorization. Choose the appropriate accounts region and scopes. Follow the common [browser OAuth workflow](../getting-started.md#connect-through-browser-oauth) for authorization start and callback completion.

## Self Client enrollment

Zoho Self Client does not have the browser start/callback sequence. Call `enrollCode(id, { code, authorize })` with a short-lived code, or include `{ replace: true }` to replace saved authorization. The `authorize` callback takes no arguments; your application checks permission for the ID it supplied before exchange. A denied callback prevents exchange. Use `credentials(id)` for subsequent reads. Do not treat Self Client enrollment as a browser OAuth callback.
