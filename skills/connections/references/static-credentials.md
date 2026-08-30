# Static credentials

Use this branch for manually provisioned API keys such as Retell AI credentials.

## Choose ownership

Use a stored static binding when the application should accept, persist, replace, and delete the credential:

```ts
import {
  MemoryTokenStore,
  RetellAIProvider,
  TokenManager,
} from "@indev42/connections";

const manager = new TokenManager({
  providers: {
    retell: {
      adapter: new RetellAIProvider(),
      store: new MemoryTokenStore(),
    },
  },
});

const key = { provider: "retell", accountId: tenantId };

await manager.saveCredential({
  key,
  credential: submittedApiKey,
});
```

Use a sourced static binding when deployment configuration, a secret manager adapter, or another external system owns the raw credential:

```ts
import {
  EnvironmentCredentialSource,
  RetellAIProvider,
  TokenManager,
} from "@indev42/connections";

const manager = new TokenManager({
  providers: {
    retell: {
      adapter: new RetellAIProvider(),
      source: new EnvironmentCredentialSource({
        runtimeEnv: process.env,
        key: ({ accountId }) => `RETELL_API_KEY_${accountId}`,
      }),
    },
  },
});
```

Environment source values are returned unchanged. Missing values become the manager's missing-token path. Ensure any dynamic environment key is compatible with the deployment platform and cannot be redirected to another tenant's secret by untrusted identifiers.

## Retrieve and rotate

Retrieve either binding shape through the same API:

```ts
const apiKey = await manager.getValidAccessToken(key);
```

For a stored binding, replace the credential with another `saveCredential` call and disconnect with `revoke`. For a sourced binding, change the external source and rotate or revoke the credential at the service; manager mutation operations are unsupported.

Static credentials never refresh. If a static record has `expiresAt`, it remains usable until that exact epoch-millisecond timestamp and then throws `TokenExpiredError`. If it has no `expiresAt`, the library treats it as locally usable until replaced or removed; this does not verify that the provider still accepts it.

## Verify

Test missing configuration, successful normalization and retrieval, tenant/key isolation, rotation, and the selected ownership model's disconnect behavior. Confirm no raw API key enters logs, URLs, client state, or test snapshots.