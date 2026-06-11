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
import type { SalesforceOAuthProviderOptions } from "./salesforce.types";

type SalesforceTokenResponse = {
  access_token?: unknown;
  refresh_token?: unknown;
  token_type?: unknown;
  scope?: unknown;
  instance_url?: unknown;
  id?: unknown;
  issued_at?: unknown;
  signature?: unknown;
  id_token?: unknown;
  sfdc_community_url?: unknown;
  sfdc_community_id?: unknown;
  expires_in?: unknown;
};

export class SalesforceOAuthProvider implements OAuthProvider {
  readonly provider = "salesforce";

  private readonly options: SalesforceOAuthProviderOptions;

  constructor(options: SalesforceOAuthProviderOptions) {
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
    const url = new URL("/services/oauth2/authorize", this.loginUrl);
    const scopes = input.scopes ?? this.options.defaultScopes;

    url.searchParams.set("client_id", credentials.clientId);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("redirect_uri", input.redirectUri);
    if (scopes?.length) {
      url.searchParams.set("scope", scopes.join(" "));
    }
    if (input.state) {
      url.searchParams.set("state", input.state);
    }
    if (this.options.display) {
      url.searchParams.set("display", this.options.display);
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
        "Client secret must be provided to the Salesforce provider to exchange an authorization code",
      );
    }

    const formData = new URLSearchParams();
    formData.set("grant_type", "authorization_code");
    formData.set("client_id", credentials.clientId);
    formData.set("client_secret", credentials.clientSecret);
    formData.set("code", input.code);
    if (input.redirectUri) {
      formData.set("redirect_uri", input.redirectUri);
    }

    const data = await this.requestToken(formData);
    return this.tokenFromResponse(data);
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
        "Client secret must be provided to the Salesforce provider to refresh tokens",
      );
    }

    const formData = new URLSearchParams();
    formData.set("grant_type", "refresh_token");
    formData.set("refresh_token", input.refreshToken);
    formData.set("client_id", credentials.clientId);
    formData.set("client_secret", credentials.clientSecret);

    const data = await this.requestToken(formData);
    return this.tokenFromResponse(data, input.currentToken?.metadata);
  }

  async revokeToken(input: RevokeTokenInput): Promise<void> {
    const token = input.token.refreshToken ?? input.token.accessToken;
    const formData = new URLSearchParams();
    formData.set("token", token);

    const res = await fetch(new URL("/services/oauth2/revoke", this.loginUrl), {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: formData,
    });

    if (!res.ok) {
      throw new OAuthProviderError(
        `Response from Salesforce revoke endpoint came back with status ${res.status}`,
      );
    }
  }

  private async requestToken(
    formData: URLSearchParams,
  ): Promise<SalesforceTokenResponse> {
    const res = await fetch(new URL("/services/oauth2/token", this.loginUrl), {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: formData,
    });

    if (!res.ok) {
      throw new OAuthProviderError(
        `Response from Salesforce token endpoint came back with status ${res.status}`,
      );
    }

    let data: unknown;
    try {
      data = await res.json();
    } catch (_) {
      throw new OAuthProviderError(
        "Unable to parse json response from Salesforce token endpoint",
      );
    }

    if (!data || typeof data !== "object") {
      throw new OAuthProviderError(
        "Salesforce token response did not include a JSON object",
      );
    }

    return data as SalesforceTokenResponse;
  }

  private tokenFromResponse(
    data: SalesforceTokenResponse,
    currentMetadata?: Record<string, unknown>,
  ): TokenRecord {
    const accessToken = getString(data, "access_token");
    if (!accessToken) {
      throw new OAuthProviderError(
        "Salesforce token response did not include access_token",
      );
    }

    const token: TokenRecord = { accessToken };
    const refreshToken = getString(data, "refresh_token");
    const tokenType = getString(data, "token_type");
    const scope = getString(data, "scope");
    const expiresIn = getNumber(data, "expires_in");
    const metadata = this.metadataFromResponse(data, currentMetadata);

    if (refreshToken) {
      token.refreshToken = refreshToken;
    }
    if (tokenType) {
      token.tokenType = tokenType;
    }
    if (scope) {
      token.scopes = scope.split(/\s+/).filter(Boolean);
    }
    if (expiresIn !== undefined) {
      token.expiresAt = Date.now() + expiresIn * 1000;
    }
    if (Object.keys(metadata).length > 0) {
      token.metadata = metadata;
    }

    return token;
  }

  private metadataFromResponse(
    data: SalesforceTokenResponse,
    currentMetadata?: Record<string, unknown>,
  ): Record<string, unknown> {
    const metadata: Record<string, unknown> = { ...(currentMetadata ?? {}) };
    setStringMetadata(metadata, "instanceUrl", data.instance_url);
    setStringMetadata(metadata, "id", data.id);
    setStringMetadata(metadata, "issuedAt", data.issued_at);
    setStringMetadata(metadata, "signature", data.signature);
    setStringMetadata(metadata, "idToken", data.id_token);
    setStringMetadata(metadata, "sfdcCommunityUrl", data.sfdc_community_url);
    setStringMetadata(metadata, "sfdcCommunityId", data.sfdc_community_id);

    return metadata;
  }

  private get loginUrl(): string {
    if (this.options.loginUrl) {
      return this.options.loginUrl;
    }

    if (this.options.environment === "sandbox") {
      return "https://test.salesforce.com";
    }

    return "https://login.salesforce.com";
  }
}

function getString(
  data: SalesforceTokenResponse,
  key: keyof SalesforceTokenResponse,
): string | undefined {
  const value = data[key];
  return typeof value === "string" ? value : undefined;
}

function getNumber(
  data: SalesforceTokenResponse,
  key: keyof SalesforceTokenResponse,
): number | undefined {
  const value = data[key];
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function setStringMetadata(
  metadata: Record<string, unknown>,
  key: string,
  value: unknown,
): void {
  if (typeof value === "string") {
    metadata[key] = value;
  }
}
