import { TokenStoreError, type TokenKey, type TokenRecord, type TokenStore } from "../../core";
import type { NeonTokenStoreOptions } from "./neon.types";

export class NeonTokenStore implements TokenStore {
  readonly storeName = "neon";
  readonly tableName: string;

  private readonly options: NeonTokenStoreOptions;

  constructor(options: NeonTokenStoreOptions = {}) {
    this.options = options;
    this.tableName = options.tableName ?? "oauth_tokens";
  }

  async get(key: TokenKey): Promise<TokenRecord | null> {
    this.assertConfigured();
    throw new TokenStoreError("NeonTokenStore.get is a scaffold stub");
  }

  async put(key: TokenKey, token: TokenRecord): Promise<void> {
    this.assertConfigured();
    throw new TokenStoreError("NeonTokenStore.put is a scaffold stub");
  }

  async delete(key: TokenKey): Promise<void> {
    this.assertConfigured();
    throw new TokenStoreError("NeonTokenStore.delete is a scaffold stub");
  }

  private assertConfigured(): void {
    if (!this.options.sql) {
      throw new TokenStoreError("NeonTokenStore requires a sql client before it can be used");
    }
  }
}
