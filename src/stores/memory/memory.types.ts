import type { TokenEncryption } from "../../core";

export type MemoryTokenStoreOptions = {
  encryption?: TokenEncryption;
  storeName?: string;
};
