import { describe, expect, it } from "vitest";
import { TokenStoreError, type TokenKey, type TokenRecord } from "../../core";
import { ConvexTokenStore } from "./ConvexTokenStore";

const key: TokenKey = {
  provider: "zoho",
  accountId: "account-1",
};

const token: TokenRecord = {
  accessToken: "access-token",
  refreshToken: "refresh-token",
};

describe("ConvexTokenStore scaffold behavior", () => {
  it("throws a clear TokenStoreError when get is called without a client", async () => {
    const store = new ConvexTokenStore();

    await expect(store.get(key)).rejects.toThrow(TokenStoreError);
    await expect(store.get(key)).rejects.toThrow(
      "ConvexTokenStore requires a client before it can be used",
    );
  });

  it("throws a clear TokenStoreError when put is called without a client", async () => {
    const store = new ConvexTokenStore();

    await expect(store.put(key, token)).rejects.toThrow(TokenStoreError);
    await expect(store.put(key, token)).rejects.toThrow(
      "ConvexTokenStore requires a client before it can be used",
    );
  });

  it("throws a clear TokenStoreError when delete is called without a client", async () => {
    const store = new ConvexTokenStore();

    await expect(store.delete(key)).rejects.toThrow(TokenStoreError);
    await expect(store.delete(key)).rejects.toThrow(
      "ConvexTokenStore requires a client before it can be used",
    );
  });

});
