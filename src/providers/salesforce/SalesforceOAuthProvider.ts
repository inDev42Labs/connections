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
  error?: unknown;
  error_description?: unknown;
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
  private readonly options: SalesforceOAuthProviderOptions;

  constructor(options: SalesforceOAuthProviderOptions) {
    this.options = options;
  }

  async getAuthorizationUrl(input: AuthorizationUrlInput): Promise<string> {
    const credentials = await resolveOAuthClientCredentials(
      this.options.credentials,
      {
        provider: input.key.provider,
        operation: "authorizationUrl",
        key: input.key,
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
        provider: input.key.provider,
        operation: "exchangeCode",
        key: input.key,
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
        provider: input.key.provider,
        operation: "refreshToken",
        key: input.key,
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
    const url = new URL("/services/oauth2/token", this.loginUrl);
    // https://help.salesforce.com/s/articleView?id=xcloud.remoteaccess_oauth_web_server_flow.htm
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: formData,
    });

    let data: unknown;
    try {
      data = await res.json();
    } catch (cause) {
      throw new OAuthProviderError(
        `Salesforce token endpoint returned invalid JSON (status ${res.status})`,
        {
          cause,
          status: res.status,
          details: { endpointHost: url.host, responseWasJson: false },
        },
      );
    }

    if (!data || typeof data !== "object") {
      throw new OAuthProviderError(
        `Salesforce token response must be a JSON object (status ${res.status})`,
        {
          status: res.status,
          details: { endpointHost: url.host, responseWasJson: true },
        },
      );
    }

    const response = data as SalesforceTokenResponse;
    const oauthError = strictOptionalString(response, "error", res.status);
    const description = strictOptionalString(
      response,
      "error_description",
      res.status,
    );
    if (oauthError) {
      const safeDescription = sanitizeDescription(description);
      throw new OAuthProviderError(
        `Salesforce token request failed with OAuth error '${oauthError}'${safeDescription ? `: ${safeDescription}` : ""} (status ${res.status})`,
        {
          status: res.status,
          oauthErrorCode: oauthError,
          details: {
            endpointHost: url.host,
            responseWasJson: true,
            ...(safeDescription ? { description: safeDescription } : {}),
          },
        },
      );
    }
    if (!res.ok) {
      throw new OAuthProviderError(
        `Salesforce token endpoint returned status ${res.status}`,
        {
          status: res.status,
          details: { endpointHost: url.host, responseWasJson: true },
        },
      );
    }

    validateOptionalResponseFields(response, res.status);
    return response;
  }

  private tokenFromResponse(
    data: SalesforceTokenResponse,
    currentMetadata?: Record<string, unknown>,
  ): TokenRecord {
    const accessToken = getString(data, "access_token");
    if (!accessToken || accessToken.trim() === "") {
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
      const expiresAt = Date.now() + expiresIn * 1000;
      if (!Number.isFinite(expiresAt)) {
        throw invalidResponseField("expires_in", undefined, "is too large");
      }
      token.expiresAt = expiresAt;
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
    return value >= 0 ? value : undefined;
  }
  if (typeof value === "string") {
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
  }
  return undefined;
}

function strictOptionalString(
  data: SalesforceTokenResponse,
  key: keyof SalesforceTokenResponse,
  status: number,
): string | undefined {
  const value = data[key];
  if (value === undefined) return undefined;
  if (typeof value !== "string") {
    throw invalidResponseField(key, status, "must be a string");
  }
  return value;
}

function validateOptionalResponseFields(
  data: SalesforceTokenResponse,
  status: number,
): void {
  const stringFields: (keyof SalesforceTokenResponse)[] = [
    "access_token",
    "refresh_token",
    "token_type",
    "scope",
    "instance_url",
    "id",
    "issued_at",
    "signature",
    "id_token",
    "sfdc_community_url",
    "sfdc_community_id",
  ];
  for (const field of stringFields) {
    strictOptionalString(data, field, status);
  }
  if (
    typeof data.access_token !== "string" ||
    data.access_token.trim() === ""
  ) {
    throw invalidResponseField("access_token", status, "is missing");
  }
  if (
    data.refresh_token !== undefined &&
    (data.refresh_token as string).trim() === ""
  ) {
    throw invalidResponseField("refresh_token", status, "must be non-empty");
  }
  if (data.expires_in !== undefined) {
    const expiresIn = getNumber(data, "expires_in");
    if (expiresIn === undefined) {
      throw invalidResponseField(
        "expires_in",
        status,
        "must be a finite non-negative number",
      );
    }
    if (!Number.isFinite(Date.now() + expiresIn * 1000)) {
      throw invalidResponseField("expires_in", status, "is too large");
    }
  }
}

function invalidResponseField(
  field: keyof SalesforceTokenResponse,
  status: number | undefined,
  reason: string,
): OAuthProviderError {
  return new OAuthProviderError(
    `Salesforce token response is invalid: ${field} ${reason}`,
    {
      status,
      details: { responseWasJson: true, invalidFields: [field] },
    },
  );
}

function sanitizeDescription(value: string | undefined): string | undefined {
  if (!value) return undefined;
  return value
    .replace(/(access_token|refresh_token|code|client_secret)\s*[=:]\s*[^\s&,]+/gi, "$1=[REDACTED]")
    .slice(0, 300);
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
