import type { OAuthClientCredentials } from "../../core";

export type SalesforceEnvironment = "production" | "sandbox";

export type SalesforceOAuthProviderOptions = {
  credentials: OAuthClientCredentials;
  loginUrl?: string;
  environment?: SalesforceEnvironment;
  defaultScopes?: string[];
  display?: string;
  prompt?: string;
};
