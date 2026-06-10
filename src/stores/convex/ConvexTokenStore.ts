import { TokenStoreError, type TokenKey, type TokenRecord, type TokenStore } from "../../core";
import type { ConvexTokenStoreOptions } from "./convex.types";

export class ConvexTokenStore implements TokenStore {
  readonly storeName = "convex";

  private readonly options: ConvexTokenStoreOptions;

  constructor(options: ConvexTokenStoreOptions = {}) {
    this.options = options;
  }

  async get(key: TokenKey): Promise<TokenRecord | null> {
    this.assertConfigured();
    throw new TokenStoreError("ConvexTokenStore.get is a scaffold stub");
  }

  async put(key: TokenKey, token: TokenRecord): Promise<void> {
    this.assertConfigured();
    throw new TokenStoreError("ConvexTokenStore.put is a scaffold stub");
  }

  async delete(key: TokenKey): Promise<void> {
    this.assertConfigured();
    throw new TokenStoreError("ConvexTokenStore.delete is a scaffold stub");
  }

  private assertConfigured(): void {
    if (!this.options.client) {
      throw new TokenStoreError("ConvexTokenStore requires a client before it can be used");
    }
  }
}
