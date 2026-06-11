import { afterEach, describe, expect, it, vi } from "vitest";
import { OAuthProviderError } from "../../core";
import { ZohoOAuthProvider } from "./ZohoOAuthProvider";

describe("ZohoOAuthProvider", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("builds the authorization URL with Zoho parameters", async () => {
    const provider = new ZohoOAuthProvider({
      credentials: { clientId: "client-id" },
      dataCenter: "ca",
      prompt: "consent",
    });

    const url = new URL(
      await provider.getAuthorizationUrl({
        redirectUri: "https://app.example/oauth/callback",
        scopes: ["ZohoCRM.modules.READ", "ZohoCRM.settings.READ"],
        state: "csrf-token",
      }),
    );

    expect(`${url.origin}${url.pathname}`).toBe(
      "https://accounts.zohocloud.ca/oauth/v2/auth",
    );
    expect(url.searchParams.get("client_id")).toBe("client-id");
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("redirect_uri")).toBe(
      "https://app.example/oauth/callback",
    );
    expect(url.searchParams.get("scope")).toBe(
      "ZohoCRM.modules.READ,ZohoCRM.settings.READ",
    );
    expect(url.searchParams.get("access_type")).toBe("offline");
    expect(url.searchParams.get("state")).toBe("csrf-token");
    expect(url.searchParams.get("prompt")).toBe("consent");
  });

  it("exchanges an authorization code at the token endpoint", async () => {
    vi.spyOn(Date, "now").mockReturnValue(1_000);
    const fetchMock = vi.fn(async (_url: URL | string, _init?: RequestInit) =>
      Response.json({
        access_token: "access-token",
        refresh_token: "refresh-token",
        token_type: "Bearer",
        expires_in: 3600,
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const provider = new ZohoOAuthProvider({
      credentials: {
        clientId: "client-id",
        clientSecret: "client-secret",
      },
    });

    await expect(
      provider.exchangeCode({
        code: "authorization-code",
        redirectUri: "https://app.example/oauth/callback",
      }),
    ).resolves.toEqual({
      accessToken: "access-token",
      refreshToken: "refresh-token",
      tokenType: "Bearer",
      expiresAt: 3_601_000,
    });
    const [url, init] = fetchMock.mock.calls[0]!;
    const body = init?.body as URLSearchParams;
    expect(String(url)).toBe("https://accounts.zoho.com/oauth/v2/token");
    expect(init?.method).toBe("POST");
    expect(init?.headers).toEqual({
      "Content-Type": "application/x-www-form-urlencoded",
    });
    expect(body.get("grant_type")).toBe("authorization_code");
    expect(body.get("client_id")).toBe("client-id");
    expect(body.get("client_secret")).toBe("client-secret");
    expect(body.get("code")).toBe("authorization-code");
    expect(body.get("redirect_uri")).toBe(
      "https://app.example/oauth/callback",
    );
  });

  it("refreshes an access token at the token endpoint", async () => {
    vi.spyOn(Date, "now").mockReturnValue(1_000);
    const fetchMock = vi.fn(async (_url: URL | string, _init?: RequestInit) =>
      Response.json({
        access_token: "new-access-token",
        token_type: "Bearer",
        expires_in: 3600,
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const provider = new ZohoOAuthProvider({
      credentials: {
        clientId: "client-id",
        clientSecret: "client-secret",
      },
    });

    await expect(
      provider.refreshToken({ refreshToken: "refresh-token" }),
    ).resolves.toEqual({
      accessToken: "new-access-token",
      tokenType: "Bearer",
      expiresAt: 3_601_000,
    });
    const [url, init] = fetchMock.mock.calls[0]!;
    const body = init?.body as URLSearchParams;
    expect(String(url)).toBe("https://accounts.zoho.com/oauth/v2/token");
    expect(init?.method).toBe("POST");
    expect(body.get("grant_type")).toBe("refresh_token");
    expect(body.get("refresh_token")).toBe("refresh-token");
    expect(body.get("client_id")).toBe("client-id");
    expect(body.get("client_secret")).toBe("client-secret");
  });

  it("revokes the available token at the revoke endpoint", async () => {
    const fetchMock = vi.fn(
      async (_url: URL | string, _init?: RequestInit) =>
        Response.json({ status: "success" }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const provider = new ZohoOAuthProvider({
      credentials: { clientId: "client-id" },
    });

    await provider.revokeToken({ token: { accessToken: "access-token" } });

    const [url, init] = fetchMock.mock.calls[0]!;
    const revokeUrl = new URL(String(url));
    expect(`${revokeUrl.origin}${revokeUrl.pathname}`).toBe(
      "https://accounts.zoho.com/oauth/v2/token/revoke",
    );
    expect(revokeUrl.searchParams.get("token")).toBe("access-token");
    expect(init?.method).toBe("POST");
  });

  it("throws when Zoho rejects token revocation", async () => {
    const fetchMock = vi.fn(
      async (_url: URL | string, _init?: RequestInit) =>
        new Response(null, { status: 400 }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const provider = new ZohoOAuthProvider({
      credentials: { clientId: "client-id" },
    });

    await expect(
      provider.revokeToken({ token: { accessToken: "access-token" } }),
    ).rejects.toBeInstanceOf(OAuthProviderError);
  });
});
