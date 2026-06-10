import { describe, expect, it } from "vitest";
import { serializeTokenKey } from "./store";

describe("serializeTokenKey", () => {
  it("serializes missing connectionId consistently", () => {
    expect(
      serializeTokenKey({ provider: "zoho", accountId: "account-1" }),
    ).toBe(
      serializeTokenKey({
        provider: "zoho",
        accountId: "account-1",
        connectionId: undefined,
      }),
    );
  });

  it("produces different keys for different providers", () => {
    expect(
      serializeTokenKey({ provider: "zoho", accountId: "account-1" }),
    ).not.toBe(
      serializeTokenKey({ provider: "google", accountId: "account-1" }),
    );
  });

  it("produces different keys for different accountIds", () => {
    expect(
      serializeTokenKey({ provider: "zoho", accountId: "account-1" }),
    ).not.toBe(
      serializeTokenKey({ provider: "zoho", accountId: "account-2" }),
    );
  });

  it("produces different keys for different connectionIds", () => {
    expect(
      serializeTokenKey({
        provider: "zoho",
        accountId: "account-1",
        connectionId: "connection-1",
      }),
    ).not.toBe(
      serializeTokenKey({
        provider: "zoho",
        accountId: "account-1",
        connectionId: "connection-2",
      }),
    );
  });
});
