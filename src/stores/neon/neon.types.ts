import type { TokenEncryption } from "../../core";

export type NeonTokenStoreOptions = {
  sql?: unknown;
  tableName?: string;
  encryption?: TokenEncryption;
};
