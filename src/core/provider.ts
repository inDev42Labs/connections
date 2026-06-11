import type { Awaitable, TokenRecord } from "./types";

export type AuthorizationUrlInput = {
  redirectUri: string;
  scopes?: string[];
  state?: string;
  metadata?: Record<string, unknown>;
};

export type ExchangeCodeInput = {
  code: string;
  redirectUri?: string;
  metadata?: Record<string, unknown>;
};

export type RefreshTokenInput = {
  refreshToken: string;
  currentToken?: TokenRecord;
  metadata?: Record<string, unknown>;
};

export type RevokeTokenInput = {
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
