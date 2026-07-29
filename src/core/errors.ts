export class ConnectionsError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = new.target.name;
  }
}

export class InvalidTokenRecordError extends ConnectionsError {
  readonly code = "INVALID_TOKEN_RECORD";
  readonly fields: string[];

  constructor(message: string, fields: string[] = [], options?: ErrorOptions) {
    super(message, options);
    this.fields = fields;
  }
}

export class TokenNotFoundError extends ConnectionsError {
  constructor(message = "Token was not found") {
    super(message);
  }
}

export class MissingRefreshTokenError extends ConnectionsError {
  constructor(message = "Token cannot be refreshed without a refresh token") {
    super(message);
  }
}

export class OAuthProviderNotRegisteredError extends ConnectionsError {
  constructor(provider: string) {
    super(`No OAuth provider is registered for '${provider}'`);
  }
}

export type OAuthProviderErrorOptions = ErrorOptions & {
  status?: number;
  oauthErrorCode?: string;
  details?: Record<string, unknown>;
};

export class OAuthProviderError extends ConnectionsError {
  readonly code = "OAUTH_PROVIDER_ERROR";
  readonly status?: number;
  readonly oauthErrorCode?: string;
  readonly details?: Record<string, unknown>;

  constructor(message: string, options: OAuthProviderErrorOptions = {}) {
    super(message, options);
    this.status = options.status;
    this.oauthErrorCode = options.oauthErrorCode;
    this.details = options.details;
  }
}

export class TokenRefreshError extends ConnectionsError {}

export class TokenStoreError extends ConnectionsError {}
