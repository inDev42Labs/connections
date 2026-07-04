import type { TokenEncryption } from "../../core";

export type ConvexTokenGetArgs = {
  tokenKey: string;
  provider: string;
  accountId: string;
  connectionId: string | null;
};

export type ConvexTokenPutArgs = ConvexTokenGetArgs & {
  tokenData: string;
};

export type ConvexTokenDeleteArgs = ConvexTokenGetArgs;

export type ConvexTokenGetResult =
  | string
  | null
  | { tokenData: string }
  | { token_data: string };

export type ConvexClient = {
  query<Result = unknown>(functionReference: unknown, args: unknown): Promise<Result>;
  mutation<Result = unknown>(functionReference: unknown, args: unknown): Promise<Result>;
};

export type ConvexTokenStoreFunctions = {
  get: unknown;
  put: unknown;
  delete: unknown;
};

export type ConvexTokenStoreOptions = {
  client: ConvexClient;
  functions: ConvexTokenStoreFunctions;
  encryption?: TokenEncryption;
};
