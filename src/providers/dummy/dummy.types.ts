export type DummyOAuthProviderOptions = {
  provider?: string;
  authorizationUrl?: string;
  defaultScopes?: string[];
  accessTokenPrefix?: string;
  refreshTokenPrefix?: string;
  refreshedAccessTokenPrefix?: string;
  tokenType?: string;
  expiresInMs?: number;
  now?: () => number;
};
