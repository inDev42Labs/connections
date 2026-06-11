import {
  OAuthProviderError,
  resolveOAuthClientCredentials,
  type AuthorizationUrlInput,
  type ExchangeCodeInput,
  type OAuthProvider,
  type RefreshTokenInput,
  type RevokeTokenInput,
  type TokenRecord,
} from "../../core";
import type { ZohoOAuthProviderOptions } from "./zoho.types";

export class ZohoOAuthProvider implements OAuthProvider {
  readonly provider = "zoho";

  private readonly options: ZohoOAuthProviderOptions;

  constructor(options: ZohoOAuthProviderOptions) {
    this.options = options;
  }

  async getAuthorizationUrl(input: AuthorizationUrlInput): Promise<string> {
    const credentials = await resolveOAuthClientCredentials(
      this.options.credentials,
      {
        provider: this.provider,
        operation: "authorizationUrl",
        metadata: input.metadata,
      },
    );
    const url = new URL("/oauth/v2/auth", this.accountsUrl);

    url.searchParams.set("client_id", credentials.clientId);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("redirect_uri", input.redirectUri);
    url.searchParams.set(
      "scope",
      (input.scopes ?? this.options.defaultScopes ?? []).join(","),
    );
    url.searchParams.set("access_type", this.options.accessType ?? "offline");
    if (input.state) {
      url.searchParams.set("state", input.state);
    }
    if (this.options.prompt) {
      url.searchParams.set("prompt", this.options.prompt);
    }

    return url.toString();
  }

  async exchangeCode(input: ExchangeCodeInput): Promise<TokenRecord> {
    const credentials = await resolveOAuthClientCredentials(
      this.options.credentials,
      {
        provider: this.provider,
        operation: "exchangeCode",
        metadata: input.metadata,
      },
    );
    if (!credentials.clientSecret) {
      throw new OAuthProviderError(
        "Client secret must be provided to the Zoho provider to exchange an authorization code",
      );
    }

    const url = new URL("/oauth/v2/token", this.accountsUrl);
    const formData = new URLSearchParams();
    formData.set("grant_type", "authorization_code");
    formData.set("client_id", credentials.clientId);
    formData.set("client_secret", credentials.clientSecret);
    formData.set("code", input.code);
    if (input.redirectUri) {
      formData.set("redirect_uri", input.redirectUri);
    }

    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: formData,
    });

    if (!res.ok) {
      throw new OAuthProviderError(
        `Response from Zoho authorization url came back with status ${res.status}`,
      );
    }

    let data: any;
    try {
      data = await res.json();
    } catch (_) {
      throw new Error(
        `Unabled to parse json response from Zoho authorization url`,
      );
    }

    return {
      accessToken: data.access_token,
      refreshToken: data.refresh_token,
      tokenType: data.token_type,
      expiresAt: Date.now() + data.expires_in * 1000,
    };
  }

  async refreshToken(input: RefreshTokenInput): Promise<TokenRecord> {
    const credentials = await resolveOAuthClientCredentials(
      this.options.credentials,
      {
        provider: this.provider,
        operation: "refreshToken",
        metadata: input.metadata,
      },
    );
    if (!credentials.clientSecret) {
      throw new OAuthProviderError(
        "Client secret must be provided to the Zoho provider to refresh tokens",
      );
    }

    const url = new URL("/oauth/v2/token", this.accountsUrl);
    const formData = new URLSearchParams();
    formData.set("refresh_token", input.refreshToken);
    formData.set("client_id", credentials.clientId);
    formData.set("client_secret", credentials.clientSecret);
    formData.set("grant_type", "refresh_token");

    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: formData,
    });

    if (!res.ok) {
      throw new OAuthProviderError(
        `Response from Zoho authorization url came back with status ${res.status}`,
      );
    }

    let data: any;
    try {
      data = await res.json();
    } catch (_) {
      throw new OAuthProviderError(
        `Unabled to parse json response from Zoho authorization url`,
      );
    }

    return {
      accessToken: data.access_token,
      tokenType: data.token_type,
      expiresAt: Date.now() + data.expires_in * 1000,
    };
  }

  async revokeToken(input: RevokeTokenInput): Promise<void> {
    const token = input.token.refreshToken ?? input.token.accessToken;
    const url = new URL("/oauth/v2/token/revoke", this.accountsUrl);
    url.searchParams.set("token", token);
    const res = await fetch(url, {
      method: "POST",
    });

    if (!res.ok) {
      throw new OAuthProviderError(
        `Response from Zoho revoke url came back with status ${res.status}`,
      );
    }
  }

  private get accountsUrl(): string {
    if (this.options.accountsUrl) {
      return this.options.accountsUrl;
    }

    if (this.options.dataCenter === "ca") {
      return "https://accounts.zohocloud.ca";
    }

    return `https://accounts.zoho.${this.options.dataCenter ?? "com"}`;
  }
}
