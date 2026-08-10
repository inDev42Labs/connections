# Retell AI Provider

`RetellAIProvider` converts a manually provisioned Retell API key into a static bearer token for `TokenManager`. Retell API keys do not use OAuth and must be created, rotated, and deleted in the Retell dashboard.

Retell authentication documentation:

- [API key overview](https://docs.retellai.com/accounts/api-keys-overview)
- [Manage API keys and permissions](https://docs.retellai.com/accounts/manage-api-keys)
- [API reference](https://docs.retellai.com/api-references/overview)

## Usage

```ts
import {
  bindStaticProvider,
  EnvironmentCredentialSource,
  MemoryTokenStore,
  RetellAIProvider,
  TokenManager,
} from "@indev42/connections";

const retell = new RetellAIProvider();
const manager = new TokenManager({
  providers: {
    retell: bindStaticProvider(retell, {
      source: new EnvironmentCredentialSource({
        key: "RETELL_API_KEY",
        runtimeEnv: process.env,
      }),
    }),
  },
});
const key = {
  provider: retell.provider,
  accountId: "workspace-id",
};

const apiKey = await manager.getValidAccessToken(key);
await fetch("https://api.retellai.com/v2/list-calls", {
  method: "POST",
  headers: {
    Authorization: `Bearer ${apiKey}`,
    "Content-Type": "application/json",
  },
  body: JSON.stringify({}),
});
```

The environment variable contains only the raw API key. `EnvironmentCredentialSource` returns that value unchanged, and `RetellAIProvider` converts it to a static bearer token in memory. The source-backed binding is read-only; delete or rotate the environment value and the API key in Retell rather than calling `manager.revoke(key)`.

To manage the token through a standard writable store instead, bind the provider to a `TokenStore` and call `saveCredential`:

```ts
const store = new MemoryTokenStore();
const manager = new TokenManager({
  providers: {
    retell: bindStaticProvider(new RetellAIProvider(), { store }),
  },
});

await manager.saveCredential({ key, credential: process.env.RETELL_API_KEY! });
```

Retell permissions are configured on the API key in the dashboard. They are not OAuth scopes and are therefore not copied into `TokenRecord.scopes`.
