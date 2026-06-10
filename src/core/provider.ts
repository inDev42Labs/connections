import type { Awaitable, TokenKey, TokenRecord } from "./types";

export type AuthorizationUrlInput = {
  key?: TokenKey;
  redirectUri: string;
  scopes?: string[];
  state?: string;
  metadata?: Record<string, unknown>;
};

export type ExchangeCodeInput = {
  key?: TokenKey;
  code: string;
  redirectUri: string;
  metadata?: Record<string, unknown>;
};

export type RefreshTokenInput = {
  key: TokenKey;
  refreshToken: string;
  currentToken?: TokenRecord;
  metadata?: Record<string, unknown>;
};

export type RevokeTokenInput = {
  key: TokenKey;
  token: TokenRecord;
  metadata?: Record<string, unknown>;
};

export interface OAuthProvider {
  readonly provider: string;

  getAuthorizationUrl(input: AuthorizationUrlInput): Awaitable<string>;

  exchangeCode(input: ExchangeCodeInput): Promise<TokenRecord>;

  refreshToken(input: RefreshTokenInput): Promise<TokenRecord>;

  revokeToken?(input: RevokeTokenInput): Promise<void>;
}
