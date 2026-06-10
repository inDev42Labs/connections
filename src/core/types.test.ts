import { describe, expect, it, vi } from "vitest";
import { resolveOAuthClientCredentials } from "./types";
import type { OAuthRequestContext } from "./types";

describe("OAuth credential resolution", () => {
  it("returns static credentials", async () => {
    const credentials = {
      clientId: "client-id",
      clientSecret: "client-secret",
    };

    await expect(
      resolveOAuthClientCredentials(credentials, {
        provider: "zoho",
        operation: "refreshToken",
      }),
    ).resolves.toBe(credentials);
  });

  it("resolves async credential functions", async () => {
    await expect(
      resolveOAuthClientCredentials(async () => ({ clientId: "client-id" }), {
        provider: "zoho",
        operation: "refreshToken",
      }),
    ).resolves.toEqual({ clientId: "client-id" });
  });

  it("passes provider, operation, key, and metadata into credential resolvers when available", async () => {
    const context: OAuthRequestContext = {
      provider: "zoho",
      operation: "refreshToken",
      key: {
        provider: "zoho",
        accountId: "account-1",
        connectionId: "connection-1",
      },
      metadata: {
        tenantId: "tenant-1",
      },
    };
    const resolver = vi.fn(async () => ({ clientId: "client-id" }));

    await resolveOAuthClientCredentials(resolver, context);

    expect(resolver).toHaveBeenCalledWith(context);
  });
});
