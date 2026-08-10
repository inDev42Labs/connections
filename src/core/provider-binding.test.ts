import { describe, expect, it, vi } from "vitest";
import { RetellAIProvider } from "../providers/retell/RetellAIProvider";
import { EnvironmentCredentialSource } from "../sources/environment";
import { MemoryTokenStore } from "../stores/memory/MemoryTokenStore";
import { bindStaticProvider } from "./binding";
import {
  ProviderCapabilityError,
  ProviderNotRegisteredError,
  TokenNotFoundError,
} from "./errors";
import { TokenManager } from "./manager";
import type { OAuthProvider } from "./provider";

describe("TokenManager provider bindings", () => {
  it("routes each provider through its configured store", async () => {
    const firstStore = new MemoryTokenStore();
    const secondStore = new MemoryTokenStore();
    const first = createOAuthProvider("first");
    const second = createOAuthProvider("second");
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
    const source = new EnvironmentCredentialSource({
      key: "RETELL_API_KEY",
      runtimeEnv: { RETELL_API_KEY: "raw-retell-key" },
    });
    const manager = new TokenManager({
      providers: {
        retell: bindStaticProvider(provider, { source }),
      },
    });

    await expect(
      manager.getValidToken({ provider: "retell", accountId: "workspace-1" }),
    ).resolves.toEqual({
      accessToken: "raw-retell-key",
      lifecycle: "static",
      tokenType: "Bearer",
    });
  });

  it("reports a missing raw credential as a missing token", async () => {
    const manager = new TokenManager({
      providers: {
        retell: bindStaticProvider(new RetellAIProvider(), {
          source: new EnvironmentCredentialSource({
            key: "RETELL_API_KEY",
            runtimeEnv: {},
          }),
        }),
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
          retell: bindStaticProvider(new RetellAIProvider(), {
            source: new EnvironmentCredentialSource({
              key: "RETELL_API_KEY",
              runtimeEnv: { RETELL_API_KEY: "raw-retell-key" },
            }),
          }),
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
        retell: bindStaticProvider(new RetellAIProvider(), { store }),
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

  it("rejects a registry key that differs from its adapter provider", () => {
    expect(
      () =>
        new TokenManager({
          providers: {
            wrong: {
              adapter: createOAuthProvider("actual"),
              store: new MemoryTokenStore(),
            },
          },
        }),
    ).toThrow("Provider binding 'wrong' uses adapter 'actual'");
  });
});

function createOAuthProvider(provider: string): OAuthProvider {
  return {
    provider,
    getAuthorizationUrl: vi.fn(() => "https://example.com/oauth"),
    exchangeCode: vi.fn(async ({ code }) => ({
      accessToken: `${code}-access-token`,
    })),
    refreshToken: vi.fn(async () => ({ accessToken: "refreshed-token" })),
  };
}
