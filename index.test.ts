import { describe, expect, it } from "vitest";
import {
  ConvexTokenStore,
  MemoryTokenStore,
  MissingRefreshTokenError,
  NeonTokenStore,
  OAuthProviderNotRegisteredError,
  TokenManager,
  TokenNotFoundError,
  ZohoOAuthProvider,
} from "./index";
import { TokenManager as CoreTokenManager } from "@indev42/connections/core";
import { ConvexTokenStore as ConvexSubpathTokenStore } from "@indev42/connections/stores/convex";
import { MemoryTokenStore as MemorySubpathTokenStore } from "@indev42/connections/stores/memory";
import { NeonTokenStore as NeonSubpathTokenStore } from "@indev42/connections/stores/neon";
import { ZohoOAuthProvider as ZohoSubpathProvider } from "@indev42/connections/providers/zoho";

describe("Package public exports", () => {
  it("exports TokenManager from the root package entrypoint", () => {
    expect(TokenManager).toBe(CoreTokenManager);
  });

  it("exports core errors from the root package entrypoint", () => {
    expect(TokenNotFoundError).toBeTypeOf("function");
    expect(MissingRefreshTokenError).toBeTypeOf("function");
    expect(OAuthProviderNotRegisteredError).toBeTypeOf("function");
  });

  it("exports MemoryTokenStore from the root package entrypoint", () => {
    expect(MemoryTokenStore).toBe(MemorySubpathTokenStore);
  });

  it("exports NeonTokenStore from the root package entrypoint", () => {
    expect(NeonTokenStore).toBe(NeonSubpathTokenStore);
  });

  it("exports provider and store subpath entrypoints", () => {
    expect(ZohoOAuthProvider).toBe(ZohoSubpathProvider);
    expect(ConvexTokenStore).toBe(ConvexSubpathTokenStore);
  });
});
