import { describe, expect, it, vi } from "vitest";
import { RetellAIProvider } from "../providers/retell/RetellAIProvider";
import { EnvironmentCredentialSource } from "../sources/environment";
import { MemoryTokenStore } from "../stores/memory/MemoryTokenStore";
import {
  ProviderCapabilityError,
  ProviderNotRegisteredError,
  TokenNotFoundError,
} from "./errors";
import { TokenManager } from "./manager";
import type { CredentialSource } from "./credential-source";
import type { OAuthProvider } from "./provider";

describe("TokenManager provider bindings", () => {
  it("routes each provider through its configured store", async () => {
    const firstStore = new MemoryTokenStore();
    const secondStore = new MemoryTokenStore();
    const first = createOAuthProvider();
    const second = createOAuthProvider();
    const manager = new TokenManager({
      providers: {
        first: { adapter: first, store: firstStore },
        second: { adapter: second, store: secondStore },
      },
    });

    await manager.exchangeCodeAndSave({
      key: { provider: "second", accountId: "account-1" },
      code: "second-code",
    });

    await expect(
      secondStore.get({ provider: "second", accountId: "account-1" }),
    ).resolves.toEqual({ accessToken: "second-code-access-token" });
    await expect(
      firstStore.get({ provider: "second", accountId: "account-1" }),
    ).resolves.toBeNull();
  });

  it("normalizes a raw sourced credential without persisting it", async () => {
    const provider = new RetellAIProvider();
    const createToken = vi.spyOn(provider, "createToken");
    const source = new EnvironmentCredentialSource({
      key: "RETELL_API_KEY",
      runtimeEnv: { RETELL_API_KEY: "raw-retell-key" },
    });
    const manager = new TokenManager({
      providers: {
        retell: { adapter: provider, source },
      },
    });

    const key = { provider: "retell", accountId: "workspace-1" };

    await expect(manager.getValidToken(key)).resolves.toEqual({
      accessToken: "raw-retell-key",
      lifecycle: "static",
      tokenType: "Bearer",
    });
    expect(createToken).toHaveBeenCalledWith("raw-retell-key", { key });
  });

  it("reports a missing raw credential as a missing token", async () => {
    const manager = new TokenManager({
      providers: {
        retell: {
          adapter: new RetellAIProvider(),
          source: new EnvironmentCredentialSource({
            key: "RETELL_API_KEY",
            runtimeEnv: {},
          }),
        },
      },
    });

    await expect(
      manager.getValidToken({ provider: "retell", accountId: "workspace-1" }),
    ).rejects.toBeInstanceOf(TokenNotFoundError);
  });

  it.each(["saveToken", "revoke"] as const)(
    "rejects %s for a read-only credential source",
    async (operation) => {
      const key = { provider: "retell", accountId: "workspace-1" };
      const manager = new TokenManager({
        providers: {
          retell: {
            adapter: new RetellAIProvider(),
            source: new EnvironmentCredentialSource({
              key: "RETELL_API_KEY",
              runtimeEnv: { RETELL_API_KEY: "raw-retell-key" },
            }),
          },
        },
      });

      const result =
        operation === "saveToken"
          ? manager.saveToken({
              key,
              token: { accessToken: "replacement", lifecycle: "static" },
            })
          : manager.revoke(key);

      await expect(result).rejects.toBeInstanceOf(ProviderCapabilityError);
    },
  );

  it("normalizes and saves a raw credential for a stored static provider", async () => {
    const store = new MemoryTokenStore();
    const manager = new TokenManager({
      providers: {
        retell: { adapter: new RetellAIProvider(), store },
      },
    });
    const key = { provider: "retell", accountId: "workspace-1" };

    await manager.saveCredential({ key, credential: "stored-retell-key" });

    await expect(store.get(key)).resolves.toEqual({
      accessToken: "stored-retell-key",
      lifecycle: "static",
      tokenType: "Bearer",
    });
    await expect(manager.getValidAccessToken(key)).resolves.toBe(
      "stored-retell-key",
    );
  });

  it("requires a binding for every token key provider", async () => {
    const manager = new TokenManager();

    await expect(
      manager.getValidToken({ provider: "missing", accountId: "account-1" }),
    ).rejects.toBeInstanceOf(ProviderNotRegisteredError);
  });

  it("uses the registry key as the provider namespace", async () => {
    const store = new MemoryTokenStore();
    const adapter = createOAuthProvider();
    const manager = new TokenManager({
      providers: {
        myCustomProviderKey: { adapter, store },
      },
    });
    const key = {
      provider: "myCustomProviderKey",
      accountId: "account-1",
    };

    await manager.exchangeCodeAndSave({ key, code: "authorization-code" });

    expect(adapter.exchangeCode).toHaveBeenCalledWith(
      expect.objectContaining({ key }),
    );
    await expect(manager.getValidAccessToken(key)).resolves.toBe(
      "authorization-code-access-token",
    );
  });

  it("type-checks source credentials against their static adapter", () => {
    const adapter = new RetellAIProvider();
    const source: CredentialSource<number> = {
      get: () => 42,
    };
    const providers = {
      incompatible: { adapter, source },
    };

    // @ts-expect-error The source value must match the adapter credential type.
    const manager = new TokenManager({ providers });

    expect(manager).toBeInstanceOf(TokenManager);
  });
});

function createOAuthProvider(): OAuthProvider {
  return {
    getAuthorizationUrl: vi.fn(() => "https://example.com/oauth"),
    exchangeCode: vi.fn(async ({ code }) => ({
      accessToken: `${code}-access-token`,
    })),
    refreshToken: vi.fn(async () => ({ accessToken: "refreshed-token" })),
  };
}
