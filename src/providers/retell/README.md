# Retell AI Provider

`RetellAIProvider` converts a manually provisioned Retell API key into a static bearer token for `TokenManager`. Retell API keys do not use OAuth and must be created, rotated, and deleted in the Retell dashboard.

Retell authentication documentation:

- [API key overview](https://docs.retellai.com/accounts/api-keys-overview)
- [Manage API keys and permissions](https://docs.retellai.com/accounts/manage-api-keys)
- [API reference](https://docs.retellai.com/api-references/overview)

## Usage

```ts
import {
  MemoryTokenStore,
  RetellAIProvider,
  TokenManager,
} from "@indev42/connections";

const manager = new TokenManager({ store: new MemoryTokenStore() });
const retell = new RetellAIProvider();
const key = {
  provider: retell.provider,
  accountId: "workspace-id",
};

await manager.saveToken({
  key,
  token: retell.createToken(process.env.RETELL_API_KEY!),
});

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

Do not add the provider to `TokenManager.providers`. Static tokens need no authorization, exchange, refresh, or remote revocation adapter. `manager.revoke(key)` deletes the local record; delete or rotate the API key in Retell to invalidate it remotely.

Retell permissions are configured on the API key in the dashboard. They are not OAuth scopes and are therefore not copied into `TokenRecord.scopes`.
