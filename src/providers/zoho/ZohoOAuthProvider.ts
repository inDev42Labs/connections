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
    const credentials = await resolveOAuthClientCredentials(this.options.credentials, {
      provider: this.provider,
      operation: "authorizationUrl",
      metadata: input.metadata,
    });
    const url = new URL("/oauth/v2/auth", this.accountsUrl);

    url.searchParams.set("client_id", credentials.clientId);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("redirect_uri", input.redirectUri);
    url.searchParams.set("scope", (input.scopes ?? this.options.defaultScopes ?? []).join(","));
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
    await resolveOAuthClientCredentials(this.options.credentials, {
      provider: this.provider,
      operation: "exchangeCode",
      metadata: input.metadata,
    });

    throw new OAuthProviderError("ZohoOAuthProvider.exchangeCode is a scaffold stub");
  }

  async refreshToken(input: RefreshTokenInput): Promise<TokenRecord> {
    await resolveOAuthClientCredentials(this.options.credentials, {
      provider: this.provider,
      operation: "refreshToken",
      key: input.key,
      metadata: input.metadata,
    });

    throw new OAuthProviderError("ZohoOAuthProvider.refreshToken is a scaffold stub");
  }

  async revokeToken(input: RevokeTokenInput): Promise<void> {
    await resolveOAuthClientCredentials(this.options.credentials, {
      provider: this.provider,
      operation: "revokeToken",
      key: input.key,
      metadata: input.metadata,
    });

    throw new OAuthProviderError("ZohoOAuthProvider.revokeToken is a scaffold stub");
  }

  private get accountsUrl(): string {
    if (this.options.accountsUrl) {
      return this.options.accountsUrl;
    }

    return `https://accounts.zoho.${this.options.dataCenter ?? "com"}`;
  }
}
