import type { TokenKey, TokenRecord } from "./types";

export interface TokenStore {
  readonly storeName?: string;

  get(key: TokenKey): Promise<TokenRecord | null>;

  put(key: TokenKey, token: TokenRecord): Promise<void>;

  delete(key: TokenKey): Promise<void>;
}

export function serializeTokenKey(key: TokenKey): string {
  return JSON.stringify([key.provider, key.accountId, key.connectionId ?? null]);
}
