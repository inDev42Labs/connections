import type { TokenEncryption } from "../../core";

export type ConvexTokenStoreFunctions = {
  get?: unknown;
  put?: unknown;
  delete?: unknown;
};

export type ConvexTokenStoreOptions = {
  client?: unknown;
  functions?: ConvexTokenStoreFunctions;
  encryption?: TokenEncryption;
};
