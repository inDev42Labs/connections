import { describe, expect, it, vi } from "vitest";
import {
  MissingRefreshTokenError,
  OAuthProviderNotRegisteredError,
  TokenNotFoundError,
} from "./errors";
import { TokenManager } from "./manager";
import type { OAuthProvider } from "./provider";
import type { TokenStore } from "./store";
import type { TokenKey, TokenRecord } from "./types";
import { MemoryTokenStore } from "../stores/memory/MemoryTokenStore";

const key: TokenKey = {
  provider: "test",
  accountId: "account-1",
};

describe("TokenManager", () => {
  it("returns the stored access token when it is not expired", async () => {
    const store = createStore({
      accessToken: "stored-access-token",
      refreshToken: "stored-refresh-token",
      expiresAt: 2_000,
    });
    const provider = createProvider();
    const manager = new TokenManager({
      store,
      providers: [provider],
      now: () => 1_000,
      refreshSkewMs: 0,
    });

    await expect(manager.getValidAccessToken(key)).resolves.toBe(
      "stored-access-token",
    );
    expect(provider.refreshToken).not.toHaveBeenCalled();
  });

  it("refreshes and persists a token when it is expired", async () => {
    const store = createStore({
      accessToken: "expired-access-token",
      refreshToken: "stored-refresh-token",
      expiresAt: 999,
    });
    const refreshedToken: TokenRecord = {
      accessToken: "new-access-token",
      refreshToken: "new-refresh-token",
      expiresAt: 2_000,
    };
    const provider = createProvider({ refreshedToken });
    const manager = new TokenManager({
      store,
      providers: [provider],
      now: () => 1_000,
      refreshSkewMs: 0,
    });

    await expect(manager.getValidAccessToken(key)).resolves.toBe(
      "new-access-token",
    );
    await expect(store.get(key)).resolves.toEqual(refreshedToken);
    expect(provider.refreshToken).toHaveBeenCalledWith({
      refreshToken: "stored-refresh-token",
      currentToken: {
        accessToken: "expired-access-token",
        refreshToken: "stored-refresh-token",
        expiresAt: 999,
      },
      metadata: undefined,
    });
  });

  it("refreshes and persists a token when it is inside the refresh skew window", async () => {
    const store = createStore({
      accessToken: "soon-expiring-access-token",
      refreshToken: "stored-refresh-token",
      expiresAt: 1_050,
    });
    const provider = createProvider({
      refreshedToken: {
        accessToken: "new-access-token",
        refreshToken: "new-refresh-token",
        expiresAt: 2_000,
      },
    });
    const manager = new TokenManager({
      store,
      providers: [provider],
      now: () => 1_000,
      refreshSkewMs: 100,
    });

    await expect(manager.getValidAccessToken(key)).resolves.toBe(
      "new-access-token",
    );
    expect(provider.refreshToken).toHaveBeenCalledTimes(1);
  });

  it("preserves the existing refresh token when the provider returns no new refresh token", async () => {
    const store = createStore({
      accessToken: "expired-access-token",
      refreshToken: "stored-refresh-token",
      expiresAt: 999,
    });
    const provider = createProvider({
      refreshedToken: {
        accessToken: "new-access-token",
        expiresAt: 2_000,
      },
    });
    const manager = new TokenManager({
      store,
      providers: [provider],
      now: () => 1_000,
      refreshSkewMs: 0,
    });

    await manager.getValidToken(key);

    await expect(store.get(key)).resolves.toEqual({
      accessToken: "new-access-token",
      refreshToken: "stored-refresh-token",
      expiresAt: 2_000,
    });
  });

  it("throws TokenNotFoundError when no token exists", async () => {
    const manager = new TokenManager({
      store: createStore(null),
      providers: [createProvider()],
    });

    await expect(manager.getValidAccessToken(key)).rejects.toBeInstanceOf(
      TokenNotFoundError,
    );
  });

  it("throws MissingRefreshTokenError when an expired token has no refresh token", async () => {
    const manager = new TokenManager({
      store: createStore({
        accessToken: "expired-access-token",
        expiresAt: 999,
      }),
      providers: [createProvider()],
      now: () => 1_000,
      refreshSkewMs: 0,
    });

    await expect(manager.getValidAccessToken(key)).rejects.toBeInstanceOf(
      MissingRefreshTokenError,
    );
  });

  it("throws OAuthProviderNotRegisteredError when no provider is registered for the token key", async () => {
    const manager = new TokenManager({
      store: createStore({
        accessToken: "expired-access-token",
        refreshToken: "stored-refresh-token",
        expiresAt: 999,
      }),
      now: () => 1_000,
      refreshSkewMs: 0,
    });

    await expect(manager.getValidAccessToken(key)).rejects.toBeInstanceOf(
      OAuthProviderNotRegisteredError,
    );
  });

  it("deduplicates concurrent refreshes for the same token key", async () => {
    const store = createStore({
      accessToken: "expired-access-token",
      refreshToken: "stored-refresh-token",
      expiresAt: 999,
    });
    const refresh = deferred<TokenRecord>();
    const provider = createProvider({ refreshPromise: refresh.promise });
    const manager = new TokenManager({
      store,
      providers: [provider],
      now: () => 1_000,
      refreshSkewMs: 0,
    });

    const first = manager.getValidAccessToken(key);
    const second = manager.getValidAccessToken(key);

    await Promise.resolve();
    refresh.resolve({
      accessToken: "new-access-token",
      refreshToken: "new-refresh-token",
      expiresAt: 2_000,
    });

    await expect(Promise.all([first, second])).resolves.toEqual([
      "new-access-token",
      "new-access-token",
    ]);
    expect(provider.refreshToken).toHaveBeenCalledTimes(1);
  });

  it("does not deduplicate refreshes across different token keys", async () => {
    const firstKey = { ...key, accountId: "account-1" };
    const secondKey = { ...key, accountId: "account-2" };
    const store = createStore();
    await store.put(firstKey, {
      accessToken: "first-expired-token",
      refreshToken: "account-1-refresh-token",
      expiresAt: 999,
    });
    await store.put(secondKey, {
      accessToken: "second-expired-token",
      refreshToken: "account-2-refresh-token",
      expiresAt: 999,
    });
    const provider = createProvider({
      refreshImplementation: async (input) => ({
        accessToken: `${input.refreshToken.replace("-refresh-token", "")}-new-access-token`,
        refreshToken: `${input.refreshToken.replace("-refresh-token", "")}-new-refresh-token`,
        expiresAt: 2_000,
      }),
    });
    const manager = new TokenManager({
      store,
      providers: [provider],
      now: () => 1_000,
      refreshSkewMs: 0,
    });

    await expect(
      Promise.all([
        manager.getValidAccessToken(firstKey),
        manager.getValidAccessToken(secondKey),
      ]),
    ).resolves.toEqual([
      "account-1-new-access-token",
      "account-2-new-access-token",
    ]);
    expect(provider.refreshToken).toHaveBeenCalledTimes(2);
  });

  it("revokes through the provider before deleting the token", async () => {
    const events: string[] = [];
    const token: TokenRecord = {
      accessToken: "stored-access-token",
      refreshToken: "stored-refresh-token",
    };
    const store = createStore(token, events);
    const provider = createProvider({
      revokeImplementation: async () => {
        events.push("revoke");
      },
    });
    const manager = new TokenManager({ store, providers: [provider] });

    await manager.revoke(key, { metadata: { reason: "test" } });

    expect(events).toEqual(["revoke", "delete"]);
    expect(provider.revokeToken).toHaveBeenCalledWith({
      token,
      metadata: { reason: "test" },
    });
  });

  it("deletes the token even when no provider revoke method exists", async () => {
    const events: string[] = [];
    const store = createStore(
      {
        accessToken: "stored-access-token",
        refreshToken: "stored-refresh-token",
      },
      events,
    );
    const provider = createProvider({ withRevoke: false });
    const manager = new TokenManager({ store, providers: [provider] });

    await manager.revoke(key);

    expect(events).toEqual(["delete"]);
    await expect(store.get(key)).resolves.toBeNull();
  });
});

describe("TokenManager public OAuth flow", () => {
  it("delegates getAuthorizationUrl to the provider selected by key.provider", async () => {
    const firstProvider = createProvider({
      provider: "first",
      authorizationUrl: "https://first.example/oauth",
    });
    const secondProvider = createProvider({
      provider: "second",
      authorizationUrl: "https://second.example/oauth",
    });
    const manager = new TokenManager({
      store: createStore(),
      providers: [firstProvider, secondProvider],
    });

    await expect(
      manager.getAuthorizationUrl({
        key: { provider: "second", accountId: "account-1" },
        redirectUri: "https://app.example/oauth/callback",
      }),
    ).resolves.toBe("https://second.example/oauth");
    expect(firstProvider.getAuthorizationUrl).not.toHaveBeenCalled();
    expect(secondProvider.getAuthorizationUrl).toHaveBeenCalledTimes(1);
  });

  it("passes redirectUri, scopes, state, and metadata into getAuthorizationUrl", async () => {
    const provider = createProvider();
    const manager = new TokenManager({
      store: createStore(),
      providers: [provider],
    });
    const metadata = { tenantId: "tenant-1" };

    await manager.getAuthorizationUrl({
      key,
      redirectUri: "https://app.example/oauth/callback",
      scopes: ["scope:a", "scope:b"],
      state: "csrf-token",
      metadata,
    });

    expect(provider.getAuthorizationUrl).toHaveBeenCalledWith(
      expect.objectContaining({
        redirectUri: "https://app.example/oauth/callback",
        scopes: ["scope:a", "scope:b"],
        state: "csrf-token",
        metadata,
      }),
    );
  });

  it("throws OAuthProviderNotRegisteredError when authorization URL provider is missing", async () => {
    const manager = new TokenManager({ store: createStore() });

    await expect(
      manager.getAuthorizationUrl({
        key,
        redirectUri: "https://app.example/oauth/callback",
      }),
    ).rejects.toBeInstanceOf(OAuthProviderNotRegisteredError);
  });

  it("exchanges an authorization code through the selected provider", async () => {
    const firstProvider = createProvider({ provider: "first" });
    const secondProvider = createProvider({
      provider: "second",
      exchangedToken: { accessToken: "second-access-token" },
    });
    const manager = new TokenManager({
      store: createStore(),
      providers: [firstProvider, secondProvider],
    });

    await expect(
      manager.exchangeCodeAndSave({
        key: { provider: "second", accountId: "account-1" },
        code: "authorization-code",
        redirectUri: "https://app.example/oauth/callback",
      }),
    ).resolves.toEqual({ accessToken: "second-access-token" });
    expect(firstProvider.exchangeCode).not.toHaveBeenCalled();
    expect(secondProvider.exchangeCode).toHaveBeenCalledTimes(1);
  });

  it("persists and returns the exchanged token under the requested TokenKey", async () => {
    const store = createStore();
    const exchangedToken: TokenRecord = {
      accessToken: "exchanged-access-token",
      refreshToken: "exchanged-refresh-token",
      expiresAt: 2_000,
    };
    const provider = createProvider({ exchangedToken });
    const manager = new TokenManager({ store, providers: [provider] });

    await expect(
      manager.exchangeCodeAndSave({
        key,
        code: "authorization-code",
        redirectUri: "https://app.example/oauth/callback",
      }),
    ).resolves.toEqual(exchangedToken);
    await expect(store.get(key)).resolves.toEqual(exchangedToken);
  });

  it("passes code, redirectUri, and metadata into exchangeCode", async () => {
    const provider = createProvider();
    const manager = new TokenManager({
      store: createStore(),
      providers: [provider],
    });
    const metadata = { tenantId: "tenant-1" };

    await manager.exchangeCodeAndSave({
      key,
      code: "authorization-code",
      redirectUri: "https://app.example/oauth/callback",
      metadata,
    });

    expect(provider.exchangeCode).toHaveBeenCalledWith({
      code: "authorization-code",
      redirectUri: "https://app.example/oauth/callback",
      metadata,
    });
  });

  it("throws OAuthProviderNotRegisteredError when exchange provider is missing", async () => {
    const manager = new TokenManager({ store: createStore() });

    await expect(
      manager.exchangeCodeAndSave({
        key,
        code: "authorization-code",
        redirectUri: "https://app.example/oauth/callback",
      }),
    ).rejects.toBeInstanceOf(OAuthProviderNotRegisteredError);
  });

  it("saves an initial token under the requested TokenKey", async () => {
    const store = createStore();
    const manager = new TokenManager({ store });
    const token: TokenRecord = {
      accessToken: "initial-access-token",
      refreshToken: "initial-refresh-token",
    };

    await manager.saveInitialToken({ key, token });

    await expect(store.get(key)).resolves.toEqual(token);
  });

  it("allows providers to be registered after construction with use()", async () => {
    const provider = createProvider({ authorizationUrl: "https://example.com/late" });
    const manager = new TokenManager({ store: createStore() });

    manager.use(provider);

    await expect(
      manager.getAuthorizationUrl({
        key,
        redirectUri: "https://app.example/oauth/callback",
      }),
    ).resolves.toBe("https://example.com/late");
  });

  it("uses the most recently registered provider for a provider name", async () => {
    const firstProvider = createProvider({
      authorizationUrl: "https://first.example/oauth",
    });
    const secondProvider = createProvider({
      authorizationUrl: "https://second.example/oauth",
    });
    const manager = new TokenManager({ store: createStore() });

    manager.use(firstProvider).use(secondProvider);

    await expect(
      manager.getAuthorizationUrl({
        key,
        redirectUri: "https://app.example/oauth/callback",
      }),
    ).resolves.toBe("https://second.example/oauth");
    expect(firstProvider.getAuthorizationUrl).not.toHaveBeenCalled();
    expect(secondProvider.getAuthorizationUrl).toHaveBeenCalledTimes(1);
  });
});

describe("TokenManager refresh edge cases", () => {
  it("treats a token without expiresAt as valid and does not refresh it", async () => {
    const token: TokenRecord = {
      accessToken: "non-expiring-access-token",
      refreshToken: "stored-refresh-token",
    };
    const provider = createProvider();
    const manager = new TokenManager({
      store: createStore(token),
      providers: [provider],
      now: () => 1_000,
      refreshSkewMs: 0,
    });

    await expect(manager.getValidToken(key)).resolves.toEqual(token);
    expect(provider.refreshToken).not.toHaveBeenCalled();
  });

  it("passes request metadata into provider.refreshToken", async () => {
    const provider = createProvider();
    const manager = new TokenManager({
      store: createStore({
        accessToken: "expired-access-token",
        refreshToken: "stored-refresh-token",
        expiresAt: 999,
      }),
      providers: [provider],
      now: () => 1_000,
      refreshSkewMs: 0,
    });
    const metadata = { tenantId: "tenant-1" };

    await manager.getValidToken(key, { metadata });

    expect(provider.refreshToken).toHaveBeenCalledWith(
      expect.objectContaining({ metadata }),
    );
  });

  it("keeps the existing stored token when refreshToken rejects", async () => {
    const initialToken: TokenRecord = {
      accessToken: "expired-access-token",
      refreshToken: "stored-refresh-token",
      expiresAt: 999,
    };
    const store = createStore(initialToken);
    const provider = createProvider({
      refreshImplementation: async () => {
        throw new Error("refresh failed");
      },
    });
    const manager = new TokenManager({
      store,
      providers: [provider],
      now: () => 1_000,
      refreshSkewMs: 0,
    });

    await expect(manager.getValidToken(key)).rejects.toThrow("refresh failed");
    await expect(store.get(key)).resolves.toEqual(initialToken);
  });

  it("clears the refresh lock after refreshToken rejects so a later call can retry", async () => {
    let attempts = 0;
    const provider = createProvider({
      refreshImplementation: async () => {
        attempts += 1;

        if (attempts === 1) {
          throw new Error("first refresh failed");
        }

        return {
          accessToken: "retried-access-token",
          refreshToken: "retried-refresh-token",
          expiresAt: 2_000,
        };
      },
    });
    const manager = new TokenManager({
      store: createStore({
        accessToken: "expired-access-token",
        refreshToken: "stored-refresh-token",
        expiresAt: 999,
      }),
      providers: [provider],
      now: () => 1_000,
      refreshSkewMs: 0,
    });

    await expect(manager.getValidAccessToken(key)).rejects.toThrow(
      "first refresh failed",
    );
    await expect(manager.getValidAccessToken(key)).resolves.toBe(
      "retried-access-token",
    );
    expect(provider.refreshToken).toHaveBeenCalledTimes(2);
  });

  it("shares the same refresh rejection across concurrent requests for the same key", async () => {
    const refresh = deferred<TokenRecord>();
    const provider = createProvider({ refreshPromise: refresh.promise });
    const manager = new TokenManager({
      store: createStore({
        accessToken: "expired-access-token",
        refreshToken: "stored-refresh-token",
        expiresAt: 999,
      }),
      providers: [provider],
      now: () => 1_000,
      refreshSkewMs: 0,
    });

    const first = manager.getValidAccessToken(key);
    const second = manager.getValidAccessToken(key);
    const error = new Error("refresh failed");

    await Promise.resolve();
    refresh.reject(error);

    await expect(Promise.all([first, second])).rejects.toBe(error);
    expect(provider.refreshToken).toHaveBeenCalledTimes(1);
  });

  it("does not deduplicate refreshes for different connectionIds on the same account", async () => {
    const firstKey = { ...key, connectionId: "connection-1" };
    const secondKey = { ...key, connectionId: "connection-2" };
    const store = createStore();
    await store.put(firstKey, {
      accessToken: "first-expired-token",
      refreshToken: "connection-1-refresh-token",
      expiresAt: 999,
    });
    await store.put(secondKey, {
      accessToken: "second-expired-token",
      refreshToken: "connection-2-refresh-token",
      expiresAt: 999,
    });
    const provider = createProvider({
      refreshImplementation: async (input) => ({
        accessToken: `${input.refreshToken.replace("-refresh-token", "")}-new-access-token`,
        refreshToken: `${input.refreshToken.replace("-refresh-token", "")}-new-refresh-token`,
        expiresAt: 2_000,
      }),
    });
    const manager = new TokenManager({
      store,
      providers: [provider],
      now: () => 1_000,
      refreshSkewMs: 0,
    });

    await expect(
      Promise.all([
        manager.getValidAccessToken(firstKey),
        manager.getValidAccessToken(secondKey),
      ]),
    ).resolves.toEqual([
      "connection-1-new-access-token",
      "connection-2-new-access-token",
    ]);
    expect(provider.refreshToken).toHaveBeenCalledTimes(2);
  });

  it("preserves non-refresh fields from the current token when provider returns a partial refreshed token", async () => {
    const store = createStore({
      accessToken: "expired-access-token",
      refreshToken: "stored-refresh-token",
      expiresAt: 999,
      tokenType: "Bearer",
      scopes: ["scope:a"],
      metadata: { tenantId: "tenant-1" },
    });
    const provider = createProvider({
      refreshedToken: {
        accessToken: "new-access-token",
        expiresAt: 2_000,
      },
    });
    const manager = new TokenManager({
      store,
      providers: [provider],
      now: () => 1_000,
      refreshSkewMs: 0,
    });

    await expect(manager.getValidToken(key)).resolves.toEqual({
      accessToken: "new-access-token",
      refreshToken: "stored-refresh-token",
      expiresAt: 2_000,
      tokenType: "Bearer",
      scopes: ["scope:a"],
      metadata: { tenantId: "tenant-1" },
    });
  });
});

describe("TokenManager integration with MemoryTokenStore", () => {
  it("runs the full exchange-save-get-valid-token flow with a real MemoryTokenStore", async () => {
    const store = new MemoryTokenStore();
    const exchangedToken: TokenRecord = {
      accessToken: "exchanged-access-token",
      refreshToken: "exchanged-refresh-token",
      expiresAt: 2_000,
    };
    const provider = createProvider({ exchangedToken });
    const manager = new TokenManager({
      store,
      providers: [provider],
      now: () => 1_000,
      refreshSkewMs: 0,
    });

    await manager.exchangeCodeAndSave({
      key,
      code: "authorization-code",
      redirectUri: "https://app.example/oauth/callback",
    });

    await expect(manager.getValidAccessToken(key)).resolves.toBe(
      "exchanged-access-token",
    );
  });

  it("runs the full expired-token-refresh-persist flow with a real MemoryTokenStore", async () => {
    const store = new MemoryTokenStore();
    const provider = createProvider({
      refreshedToken: {
        accessToken: "refreshed-access-token",
        refreshToken: "refreshed-refresh-token",
        expiresAt: 2_000,
      },
    });
    const manager = new TokenManager({
      store,
      providers: [provider],
      now: () => 1_000,
      refreshSkewMs: 0,
    });

    await manager.saveInitialToken({
      key,
      token: {
        accessToken: "expired-access-token",
        refreshToken: "stored-refresh-token",
        expiresAt: 999,
      },
    });

    await expect(manager.getValidAccessToken(key)).resolves.toBe(
      "refreshed-access-token",
    );
    await expect(store.get(key)).resolves.toEqual({
      accessToken: "refreshed-access-token",
      refreshToken: "refreshed-refresh-token",
      expiresAt: 2_000,
    });
  });

  it("runs the full revoke-delete flow with a real MemoryTokenStore", async () => {
    const store = new MemoryTokenStore();
    const token: TokenRecord = {
      accessToken: "stored-access-token",
      refreshToken: "stored-refresh-token",
    };
    const provider = createProvider();
    const manager = new TokenManager({ store, providers: [provider] });

    await manager.saveInitialToken({ key, token });
    await manager.revoke(key);

    expect(provider.revokeToken).toHaveBeenCalledWith({
      token,
      metadata: undefined,
    });
    await expect(store.get(key)).resolves.toBeNull();
  });

  it("keeps tokens isolated by provider, accountId, and connectionId across the full manager flow", async () => {
    const store = new MemoryTokenStore();
    const provider = createProvider({
      exchangeImplementation: async (input) => ({
        accessToken: `${input.code}-access-token`,
        refreshToken: `${input.code}-refresh-token`,
        expiresAt: 2_000,
      }),
    });
    const manager = new TokenManager({
      store,
      providers: [provider],
      now: () => 1_000,
      refreshSkewMs: 0,
    });
    const firstKey = { ...key, connectionId: "connection-1" };
    const secondKey = { ...key, connectionId: "connection-2" };

    await manager.exchangeCodeAndSave({
      key: firstKey,
      code: "first",
      redirectUri: "https://app.example/oauth/callback",
    });
    await manager.exchangeCodeAndSave({
      key: secondKey,
      code: "second",
      redirectUri: "https://app.example/oauth/callback",
    });

    await expect(manager.getValidAccessToken(firstKey)).resolves.toBe(
      "first-access-token",
    );
    await expect(manager.getValidAccessToken(secondKey)).resolves.toBe(
      "second-access-token",
    );
  });
});

function createStore(
  initialToken?: TokenRecord | null,
  events: string[] = [],
): TokenStore {
  const records = new Map<string, TokenRecord>();

  if (initialToken) {
    records.set(JSON.stringify(key), initialToken);
  }

  return {
    async get(tokenKey) {
      return records.get(JSON.stringify(tokenKey)) ?? null;
    },
    async put(tokenKey, token) {
      records.set(JSON.stringify(tokenKey), token);
    },
    async delete(tokenKey) {
      events.push("delete");
      records.delete(JSON.stringify(tokenKey));
    },
  };
}

function createProvider(options: {
  provider?: string;
  authorizationUrl?: string;
  exchangedToken?: TokenRecord;
  refreshedToken?: TokenRecord;
  refreshPromise?: Promise<TokenRecord>;
  exchangeImplementation?: OAuthProvider["exchangeCode"];
  refreshImplementation?: OAuthProvider["refreshToken"];
  revokeImplementation?: NonNullable<OAuthProvider["revokeToken"]>;
  withRevoke?: boolean;
} = {}): OAuthProvider {
  const provider: OAuthProvider = {
    provider: options.provider ?? "test",
    getAuthorizationUrl: vi.fn(
      async () => options.authorizationUrl ?? "https://example.com/oauth",
    ),
    exchangeCode: vi.fn(
      options.exchangeImplementation ??
        (async () => options.exchangedToken ?? { accessToken: "exchanged-access-token" }),
    ),
    refreshToken: vi.fn(
      options.refreshImplementation ??
        (async () =>
          options.refreshPromise ??
          options.refreshedToken ?? {
            accessToken: "refreshed-access-token",
            refreshToken: "refreshed-refresh-token",
            expiresAt: 2_000,
          }),
    ),
  };

  if (options.withRevoke !== false) {
    provider.revokeToken = vi.fn(options.revokeImplementation ?? (async () => {}));
  }

  return provider;
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((innerResolve, innerReject) => {
    resolve = innerResolve;
    reject = innerReject;
  });

  return { promise, resolve, reject };
}
