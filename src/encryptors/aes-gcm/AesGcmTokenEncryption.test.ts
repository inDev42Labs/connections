import { describe, expect, it } from "vitest";
import type { TokenEncryptionContext, TokenKey, TokenRecord } from "../../core";
import { MemoryTokenStore } from "../../stores/memory";
import { AesGcmTokenEncryption } from "./AesGcmTokenEncryption";

const key: TokenKey = {
  provider: "zoho",
  accountId: "account-1",
};

const context: TokenEncryptionContext = {
  key,
  storeName: "memory",
};

const token: TokenRecord = {
  accessToken: "access-token",
  refreshToken: "refresh-token",
  expiresAt: 1_000,
};

describe("AesGcmTokenEncryption", () => {
  it("encrypts and decrypts token records through a store", async () => {
    const encryption = new AesGcmTokenEncryption({ key: testKey() });
    const store = new MemoryTokenStore({ encryption });

    await store.put(key, token);

    await expect(store.get(key)).resolves.toEqual(token);
  });

  it("uses a random iv for each encryption", async () => {
    const encryption = new AesGcmTokenEncryption({ key: testKey() });

    const first = await encryption.encrypt({ plaintext: "token", context });
    const second = await encryption.encrypt({ plaintext: "token", context });

    expect(first).not.toBe(second);
    await expect(encryption.decrypt({ ciphertext: first, context })).resolves.toBe("token");
    await expect(encryption.decrypt({ ciphertext: second, context })).resolves.toBe("token");
  });

  it("binds ciphertext to the token context", async () => {
    const encryption = new AesGcmTokenEncryption({ key: testKey() });
    const ciphertext = await encryption.encrypt({ plaintext: "token", context });

    await expect(
      encryption.decrypt({
        ciphertext,
        context: {
          ...context,
          key: { ...key, accountId: "different-account" },
        },
      }),
    ).rejects.toThrow();
  });

  it("rejects malformed ciphertext", async () => {
    const encryption = new AesGcmTokenEncryption({ key: testKey() });

    await expect(
      encryption.decrypt({ ciphertext: "not-a-valid-ciphertext", context }),
    ).rejects.toThrow("Invalid AES-GCM token ciphertext");
  });

  it("validates raw key length", async () => {
    const encryption = new AesGcmTokenEncryption({ key: "too-short", keyEncoding: "utf8" });

    await expect(encryption.encrypt({ plaintext: "token", context })).rejects.toThrow(
      "AES-GCM token encryption key must be 16, 24, or 32 bytes",
    );
  });
});

function testKey(): string {
  return bytesToBase64Url(new Uint8Array(32).fill(42));
}

function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }

  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}
