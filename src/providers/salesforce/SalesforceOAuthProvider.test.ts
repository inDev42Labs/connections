import { afterEach, describe, expect, it, vi } from "vitest";
import { OAuthProviderError } from "../../core";
import { SalesforceOAuthProvider } from "./SalesforceOAuthProvider";

describe("SalesforceOAuthProvider", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("builds the authorization URL with Salesforce parameters", async () => {
    const provider = new SalesforceOAuthProvider({
      credentials: { clientId: "client-id" },
      loginUrl: "https://acme.my.salesforce.com",
      defaultScopes: ["api", "refresh_token"],
      display: "popup",
      prompt: "consent",
    });

    const url = new URL(
      await provider.getAuthorizationUrl({
        redirectUri: "https://app.example/oauth/callback",
        state: "csrf-token",
      }),
    );

    expect(`${url.origin}${url.pathname}`).toBe(
      "https://acme.my.salesforce.com/services/oauth2/authorize",
    );
    expect(url.searchParams.get("client_id")).toBe("client-id");
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("redirect_uri")).toBe(
      "https://app.example/oauth/callback",
    );
    expect(url.searchParams.get("scope")).toBe("api refresh_token");
    expect(url.searchParams.get("state")).toBe("csrf-token");
    expect(url.searchParams.get("display")).toBe("popup");
    expect(url.searchParams.get("prompt")).toBe("consent");
  });

  it("uses the sandbox login host when configured", async () => {
    const provider = new SalesforceOAuthProvider({
      credentials: { clientId: "client-id" },
      environment: "sandbox",
    });

    const url = new URL(
      await provider.getAuthorizationUrl({
        redirectUri: "https://app.example/oauth/callback",
        scopes: ["api"],
      }),
    );

    expect(`${url.origin}${url.pathname}`).toBe(
      "https://test.salesforce.com/services/oauth2/authorize",
    );
    expect(url.searchParams.get("scope")).toBe("api");
  });

  it("exchanges an authorization code at the token endpoint", async () => {
    const fetchMock = vi.fn(async (_url: URL | string, _init?: RequestInit) =>
      Response.json({
        access_token: "access-token",
        refresh_token: "refresh-token",
        token_type: "Bearer",
        scope: "api refresh_token",
        instance_url: "https://na1.salesforce.com",
        id: "https://login.salesforce.com/id/00Dxx/005xx",
        issued_at: "1710000000000",
        signature: "signature",
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const provider = new SalesforceOAuthProvider({
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
      scopes: ["api", "refresh_token"],
      metadata: {
        instanceUrl: "https://na1.salesforce.com",
        id: "https://login.salesforce.com/id/00Dxx/005xx",
        issuedAt: "1710000000000",
        signature: "signature",
      },
    });
    const [url, init] = fetchMock.mock.calls[0]!;
    const body = init?.body as URLSearchParams;
    expect(String(url)).toBe("https://login.salesforce.com/services/oauth2/token");
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
    const fetchMock = vi.fn(async (_url: URL | string, _init?: RequestInit) =>
      Response.json({
        access_token: "new-access-token",
        token_type: "Bearer",
        scope: "api refresh_token",
        instance_url: "https://na2.salesforce.com",
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const provider = new SalesforceOAuthProvider({
      credentials: {
        clientId: "client-id",
        clientSecret: "client-secret",
      },
      loginUrl: "https://acme.my.salesforce.com",
    });

    await expect(
      provider.refreshToken({
        refreshToken: "refresh-token",
        currentToken: {
          accessToken: "old-access-token",
          refreshToken: "refresh-token",
          metadata: {
            instanceUrl: "https://na1.salesforce.com",
            tenantId: "tenant-id",
          },
        },
      }),
    ).resolves.toEqual({
      accessToken: "new-access-token",
      tokenType: "Bearer",
      scopes: ["api", "refresh_token"],
      metadata: {
        instanceUrl: "https://na2.salesforce.com",
        tenantId: "tenant-id",
      },
    });
    const [url, init] = fetchMock.mock.calls[0]!;
    const body = init?.body as URLSearchParams;
    expect(String(url)).toBe(
      "https://acme.my.salesforce.com/services/oauth2/token",
    );
    expect(init?.method).toBe("POST");
    expect(body.get("grant_type")).toBe("refresh_token");
    expect(body.get("refresh_token")).toBe("refresh-token");
    expect(body.get("client_id")).toBe("client-id");
    expect(body.get("client_secret")).toBe("client-secret");
  });

  it("revokes the available token at the revoke endpoint", async () => {
    const fetchMock = vi.fn(async (_url: URL | string, _init?: RequestInit) =>
      new Response(null, { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const provider = new SalesforceOAuthProvider({
      credentials: { clientId: "client-id" },
      loginUrl: "https://acme.my.salesforce.com",
    });

    await provider.revokeToken({
      token: { accessToken: "access-token", refreshToken: "refresh-token" },
    });

    const [url, init] = fetchMock.mock.calls[0]!;
    const body = init?.body as URLSearchParams;
    expect(String(url)).toBe(
      "https://acme.my.salesforce.com/services/oauth2/revoke",
    );
    expect(init?.method).toBe("POST");
    expect(init?.headers).toEqual({
      "Content-Type": "application/x-www-form-urlencoded",
    });
    expect(body.get("token")).toBe("refresh-token");
  });

  it("throws when Salesforce rejects token exchange", async () => {
    const fetchMock = vi.fn(async (_url: URL | string, _init?: RequestInit) =>
      Response.json({ error: "invalid_grant" }, { status: 400 }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const provider = new SalesforceOAuthProvider({
      credentials: {
        clientId: "client-id",
        clientSecret: "client-secret",
      },
    });

    await expect(
      provider.exchangeCode({ code: "authorization-code" }),
    ).rejects.toBeInstanceOf(OAuthProviderError);
  });
});
