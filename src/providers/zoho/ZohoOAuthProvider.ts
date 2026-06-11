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

    const url = new URL("/oauth/v2/auth", this.accountsUrl);
    const formData = new FormData();
    formData.append("grant_type", "authorization_code");
    formData.append("client_id", credentials.clientId);
    formData.append("client_secret", credentials.clientSecret);
    formData.append("code", input.code);
    if (input.redirectUri) {
      formData.append("redirect_uri", input.redirectUri);
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
      expiresAt: new Date().getTime() + data.expires_in,
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

    const url = new URL("/oauth/v2/auth", this.accountsUrl);
    url.searchParams.set("refresh_token", input.refreshToken);
    url.searchParams.set("client_id", credentials.clientId);
    url.searchParams.set("client_secret", credentials.clientSecret);
    url.searchParams.set("grant_type", "refresh_token");

    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
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
      expiresAt: new Date().getTime() + data.expires_in,
    };
  }

  async revokeToken(input: RevokeTokenInput): Promise<void> {
    const url = new URL("/oauth/v2/auth", this.accountsUrl);
    if (!input.token.refreshToken) {
      throw new OAuthProviderError(
        `A refresh token is required to revoke the token`,
      );
    }
    url.searchParams.set("token", input.token.refreshToken);
    await fetch(url, {
      method: "POST",
    });
  }

  private get accountsUrl(): string {
    if (this.options.accountsUrl) {
      return this.options.accountsUrl;
    }

    return `https://accounts.zoho.${this.options.dataCenter ?? "com"}`;
  }
}
