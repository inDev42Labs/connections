import { describe, expect, it, vi } from "vitest";
import type { TokenEncryption } from "../../core";
import type { TokenKey, TokenRecord } from "../../core";
import { MemoryTokenStore } from "./MemoryTokenStore";

const key: TokenKey = {
  provider: "zoho",
  accountId: "account-1",
};

const token: TokenRecord = {
  accessToken: "access-token",
  refreshToken: "refresh-token",
  expiresAt: 1_000,
};

describe("MemoryTokenStore", () => {
  it("stores and retrieves a token by structured key", async () => {
    const store = new MemoryTokenStore();

    await store.put(key, token);

    await expect(store.get(key)).resolves.toEqual(token);
  });

  it("returns null when no token exists for the key", async () => {
    const store = new MemoryTokenStore();

    await expect(store.get(key)).resolves.toBeNull();
  });

  it("overwrites an existing token for the same key", async () => {
    const store = new MemoryTokenStore();

    await store.put(key, token);
    await store.put(key, {
      accessToken: "new-access-token",
      refreshToken: "new-refresh-token",
      expiresAt: 2_000,
    });

    await expect(store.get(key)).resolves.toEqual({
      accessToken: "new-access-token",
      refreshToken: "new-refresh-token",
      expiresAt: 2_000,
    });
    expect(store.size).toBe(1);
  });

  it("deletes a token by structured key", async () => {
    const store = new MemoryTokenStore();

    await store.put(key, token);
    await store.delete(key);

    await expect(store.get(key)).resolves.toBeNull();
  });

  it("treats different connectionIds as different tokens", async () => {
    const store = new MemoryTokenStore();
    const firstKey = { ...key, connectionId: "connection-1" };
    const secondKey = { ...key, connectionId: "connection-2" };

    await store.put(firstKey, { ...token, accessToken: "first-access-token" });
    await store.put(secondKey, { ...token, accessToken: "second-access-token" });

    await expect(store.get(firstKey)).resolves.toMatchObject({
      accessToken: "first-access-token",
    });
    await expect(store.get(secondKey)).resolves.toMatchObject({
      accessToken: "second-access-token",
    });
  });

  it("does not store a token when encryption fails during put", async () => {
    const encryption: TokenEncryption = {
      encrypt: vi.fn(async () => {
        throw new Error("encrypt failed");
      }),
      decrypt: vi.fn(async ({ ciphertext }) => ciphertext),
    };
    const store = new MemoryTokenStore({ encryption });

    await expect(store.put(key, token)).rejects.toThrow("encrypt failed");

    expect(store.size).toBe(0);
    await expect(store.get(key)).resolves.toBeNull();
  });

  it("surfaces decryption failures during get", async () => {
    const encryption: TokenEncryption = {
      encrypt: vi.fn(async ({ plaintext }) => plaintext),
      decrypt: vi.fn(async () => {
        throw new Error("decrypt failed");
      }),
    };
    const store = new MemoryTokenStore({ encryption });

    await store.put(key, token);

    await expect(store.get(key)).rejects.toThrow("decrypt failed");
  });

  it("clears all stored tokens", async () => {
    const store = new MemoryTokenStore();

    await store.put(key, token);
    await store.put({ ...key, connectionId: "connection-1" }, token);
    store.clear();

    expect(store.size).toBe(0);
    await expect(store.get(key)).resolves.toBeNull();
  });
});
