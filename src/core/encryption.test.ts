import { describe, expect, it, vi } from "vitest";
import {
  deserializeTokenRecordFromStorage,
  serializeTokenRecordForStorage,
  type TokenEncryption,
} from "./encryption";
import type { TokenKey, TokenRecord } from "./types";

const key: TokenKey = {
  provider: "zoho",
  accountId: "account-1",
  connectionId: "connection-1",
};

const token: TokenRecord = {
  accessToken: "access-token",
  refreshToken: "refresh-token",
  expiresAt: 1_000,
  scopes: ["scope:a"],
};

describe("token storage serialization", () => {
  it("serializes a TokenRecord to JSON by default", async () => {
    const value = await serializeTokenRecordForStorage({ token, key });

    expect(JSON.parse(value)).toEqual(token);
  });

  it("deserializes a stored TokenRecord by default", async () => {
    const value = JSON.stringify(token);

    await expect(
      deserializeTokenRecordFromStorage({ value, key }),
    ).resolves.toEqual(token);
  });

  it("passes TokenKey and storeName into encryption context", async () => {
    const encryption: TokenEncryption = {
      encrypt: vi.fn(async ({ plaintext }) => plaintext),
      decrypt: vi.fn(async ({ ciphertext }) => ciphertext),
    };

    await serializeTokenRecordForStorage({
      token,
      key,
      encryption,
      storeName: "test-store",
    });

    expect(encryption.encrypt).toHaveBeenCalledWith({
      plaintext: JSON.stringify(token),
      context: {
        key,
        storeName: "test-store",
      },
    });
  });

  it("passes TokenKey and storeName into decryption context", async () => {
    const encryption: TokenEncryption = {
      encrypt: vi.fn(async ({ plaintext }) => plaintext),
      decrypt: vi.fn(async () => JSON.stringify(token)),
    };

    await deserializeTokenRecordFromStorage({
      value: "ciphertext",
      key,
      encryption,
      storeName: "test-store",
    });

    expect(encryption.decrypt).toHaveBeenCalledWith({
      ciphertext: "ciphertext",
      context: {
        key,
        storeName: "test-store",
      },
    });
  });
});
