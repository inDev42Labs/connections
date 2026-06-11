import type { OAuthClientCredentials } from "../../core";

export type ZohoDataCenter =
  | "com"
  | "com.au"
  | "eu"
  | "in"
  | "com.cn"
  | "jp"
  | "sa"
  | "ca";

export type ZohoOAuthProviderOptions = {
  credentials: OAuthClientCredentials;
  accountsUrl?: string;
  dataCenter?: ZohoDataCenter;
  defaultScopes?: string[];
  accessType?: "online" | "offline";
  prompt?: string;
};
