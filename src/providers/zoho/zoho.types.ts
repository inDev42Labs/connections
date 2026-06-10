import type { OAuthClientCredentials } from "../../core";

export type ZohoDataCenter = "com" | "eu" | "in" | "com.au" | "jp" | "ca";

export type ZohoOAuthProviderOptions = {
  credentials: OAuthClientCredentials;
  accountsUrl?: string;
  dataCenter?: ZohoDataCenter;
  defaultScopes?: string[];
  accessType?: "online" | "offline";
  prompt?: string;
};
