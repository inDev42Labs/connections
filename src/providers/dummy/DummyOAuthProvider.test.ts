import { describe, expect, it } from "vitest";
import { MemoryTokenStore } from "../../stores/memory";
import { TokenManager } from "../../core";
import { DummyOAuthProvider } from "./DummyOAuthProvider";

describe("DummyOAuthProvider", () => {
  it("builds a deterministic authorization URL without network calls", async () => {
    const provider = new DummyOAuthProvider({ defaultScopes: ["read", "write"] });

    const url = new URL(
      await provider.getAuthorizationUrl({
        redirectUri: "https://app.example/oauth/callback",
        state: "csrf-token",
      }),
    );

    expect(`${url.origin}${url.pathname}`).toBe("https://dummy.oauth.local/authorize");
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("provider")).toBe("dummy");
    expect(url.searchParams.get("redirect_uri")).toBe("https://app.example/oauth/callback");
    expect(url.searchParams.get("scope")).toBe("read write");
    expect(url.searchParams.get("state")).toBe("csrf-token");
  });

  it("exchanges a code for deterministic sample tokens", async () => {
    const provider = new DummyOAuthProvider({ now: () => 1_000, expiresInMs: 60_000 });

    await expect(provider.exchangeCode({ code: "sample-code" })).resolves.toEqual({
      accessToken: "dummy-access-sample-code",
      refreshToken: "dummy-refresh-sample-code",
      tokenType: "Bearer",
      expiresAt: 61_000,
      metadata: {
        provider: "dummy",
        code: "sample-code",
        redirectUri: undefined,
      },
    });
  });

  it("refreshes tokens deterministically", async () => {
    const provider = new DummyOAuthProvider({ now: () => 1_000, expiresInMs: 60_000 });

    await expect(
      provider.refreshToken({
        refreshToken: "dummy-refresh-sample-code",
        currentToken: {
          accessToken: "old-access-token",
          refreshToken: "dummy-refresh-sample-code",
          tokenType: "Example",
          metadata: { account: "sample" },
        },
      }),
    ).resolves.toEqual({
      accessToken: "dummy-refreshed-access-dummy-refresh-sample-code",
      tokenType: "Example",
      expiresAt: 61_000,
      metadata: {
        account: "sample",
        refreshed: true,
      },
    });
  });

  it("works with TokenManager and MemoryTokenStore for sample flows", async () => {
    const provider = new DummyOAuthProvider({ now: () => 1_000, expiresInMs: 1 });
    const store = new MemoryTokenStore();
    const manager = new TokenManager({
      store,
      providers: [provider],
      now: () => 2_000,
    });
    const key = { provider: "dummy", accountId: "account-1" };

    await manager.exchangeCodeAndSave({ key, code: "sample-code" });

    await expect(manager.getValidAccessToken(key)).resolves.toBe(
      "dummy-refreshed-access-dummy-refresh-sample-code",
    );
    await manager.revoke(key);

    expect(provider.hasRevokedToken("dummy-refresh-sample-code")).toBe(true);
    await expect(store.get(key)).resolves.toBeNull();
  });
});
