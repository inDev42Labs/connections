import { describe, expect, it } from "vitest";
import {
  deserializeTokenRecordFromStorage,
  serializeTokenRecordForStorage,
} from "./encryption";
import { InvalidTokenRecordError } from "./errors";
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

  it("rejects invalid records before serialization", async () => {
    await expect(
      serializeTokenRecordForStorage({
        token: { accessToken: undefined } as unknown as TokenRecord,
        key,
      }),
    ).rejects.toBeInstanceOf(InvalidTokenRecordError);
  });

  it("rejects invalid records after deserialization", async () => {
    await expect(
      deserializeTokenRecordFromStorage({ value: "{}", key }),
    ).rejects.toThrow("Stored token record is invalid: accessToken is missing");
  });
});
