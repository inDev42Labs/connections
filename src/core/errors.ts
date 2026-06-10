export class ConnectionsError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = new.target.name;
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

export class OAuthProviderError extends ConnectionsError {}

export class TokenRefreshError extends ConnectionsError {}

export class TokenStoreError extends ConnectionsError {}
