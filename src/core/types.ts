export type Awaitable<T> = T | Promise<T>;

export type TokenKey = {
  provider: string;
  accountId: string;
  connectionId?: string;
};

export type TokenRecord = {
  accessToken: string;
  refreshToken?: string;
  expiresAt?: number;
  tokenType?: string;
  scopes?: string[];
  metadata?: Record<string, unknown>;
};

export type OAuthOperation =
  | "authorizationUrl"
  | "exchangeCode"
  | "refreshToken"
  | "revokeToken";

export type OAuthRequestContext = {
  provider: string;
  operation: OAuthOperation;
  key?: TokenKey;
  metadata?: Record<string, unknown>;
};

export type OAuthClientCredentialValue = {
  clientId: string;
  clientSecret?: string;
};

export type OAuthClientCredentials =
  | OAuthClientCredentialValue
  | ((context: OAuthRequestContext) => Awaitable<OAuthClientCredentialValue>);

export async function resolveOAuthClientCredentials(
  credentials: OAuthClientCredentials,
  context: OAuthRequestContext,
): Promise<OAuthClientCredentialValue> {
  return typeof credentials === "function" ? await credentials(context) : credentials;
}
