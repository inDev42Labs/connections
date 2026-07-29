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

    return this.requestToken(url, formData, "exchangeCode");
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

    return this.requestToken(url, formData, "refreshToken");
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

  // https://www.zoho.com/accounts/protocol/oauth/web-server-applications.html
  private async requestToken(
    url: URL,
    formData: URLSearchParams,
    operation: "exchangeCode" | "refreshToken",
  ): Promise<TokenRecord> {
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
        `Zoho ${operation} received invalid JSON from the token endpoint (status ${res.status})`,
        {
          cause,
          status: res.status,
          details: { endpointHost: url.host, responseWasJson: false },
        },
      );
    }

    if (!isRecord(data)) {
      throw new OAuthProviderError(
        `Zoho ${operation} token response must be a JSON object (status ${res.status})`,
        {
          status: res.status,
          details: { endpointHost: url.host, responseWasJson: true },
        },
      );
    }

    const oauthError = optionalString(data, "error", operation, res.status);
    const description = optionalString(
      data,
      "error_description",
      operation,
      res.status,
    );
    if (oauthError) {
      const safeDescription = sanitizeDescription(description);
      throw new OAuthProviderError(
        `Zoho ${operation} failed with OAuth error '${oauthError}'${safeDescription ? `: ${safeDescription}` : ""} (status ${res.status})`,
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
        `Zoho ${operation} token endpoint returned status ${res.status}`,
        {
          status: res.status,
          details: { endpointHost: url.host, responseWasJson: true },
        },
      );
    }

    const accessToken = requiredNonEmptyString(
      data,
      "access_token",
      operation,
      res.status,
    );
    const refreshToken = optionalNonEmptyString(
      data,
      "refresh_token",
      operation,
      res.status,
    );
    const tokenType = optionalString(data, "token_type", operation, res.status);
    const expiresIn = optionalFiniteNumber(
      data,
      "expires_in",
      operation,
      res.status,
    );
    const token: TokenRecord = { accessToken };

    if (refreshToken !== undefined) token.refreshToken = refreshToken;
    if (tokenType !== undefined) token.tokenType = tokenType;
    if (expiresIn !== undefined) {
      const expiresAt = Date.now() + expiresIn * 1000;
      if (!Number.isFinite(expiresAt)) {
        throw invalidFieldError(
          operation,
          res.status,
          "expires_in",
          "is too large",
        );
      }
      token.expiresAt = expiresAt;
    }
    return token;
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requiredNonEmptyString(
  data: Record<string, unknown>,
  key: string,
  operation: string,
  status: number,
): string {
  const value = data[key];
  if (typeof value !== "string" || value.trim() === "") {
    throw invalidFieldError(operation, status, key, "is missing");
  }
  return value;
}

function optionalNonEmptyString(
  data: Record<string, unknown>,
  key: string,
  operation: string,
  status: number,
): string | undefined {
  if (data[key] === undefined) return undefined;
  const value = data[key];
  if (typeof value !== "string" || value.trim() === "") {
    throw invalidFieldError(operation, status, key, "must be a non-empty string");
  }
  return value;
}

function optionalString(
  data: Record<string, unknown>,
  key: string,
  operation: string,
  status: number,
): string | undefined {
  if (data[key] === undefined) return undefined;
  if (typeof data[key] !== "string") {
    throw invalidFieldError(operation, status, key, "must be a string");
  }
  return data[key];
}

function optionalFiniteNumber(
  data: Record<string, unknown>,
  key: string,
  operation: string,
  status: number,
): number | undefined {
  if (data[key] === undefined) return undefined;
  const value =
    typeof data[key] === "string" && data[key].trim() !== ""
      ? Number(data[key])
      : data[key];
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw invalidFieldError(operation, status, key, "must be a finite non-negative number");
  }
  return value;
}

function invalidFieldError(
  operation: string,
  status: number,
  field: string,
  reason: string,
): OAuthProviderError {
  return new OAuthProviderError(
    `Zoho ${operation} token response is invalid: ${field} ${reason}`,
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
