import {
  deserializeTokenRecordFromStorage,
  serializeTokenKey,
  serializeTokenRecordForStorage,
  type TokenKey,
  type TokenRecord,
  type TokenStore,
} from "../../core";
import type { MemoryTokenStoreOptions } from "./memory.types";

export class MemoryTokenStore implements TokenStore {
  readonly storeName: string;

  private readonly records = new Map<string, string>();
  private readonly options: MemoryTokenStoreOptions;

  constructor(options: MemoryTokenStoreOptions = {}) {
    this.options = options;
    this.storeName = options.storeName ?? "memory";
  }

  get size(): number {
    return this.records.size;
  }

  async get(key: TokenKey): Promise<TokenRecord | null> {
    const value = this.records.get(serializeTokenKey(key));

    if (!value) {
      return null;
    }

    return deserializeTokenRecordFromStorage({
      value,
      key,
      encryption: this.options.encryption,
      storeName: this.storeName,
    });
  }

  async put(key: TokenKey, token: TokenRecord): Promise<void> {
    const value = await serializeTokenRecordForStorage({
      token,
      key,
      encryption: this.options.encryption,
      storeName: this.storeName,
    });

    this.records.set(serializeTokenKey(key), value);
  }

  async delete(key: TokenKey): Promise<void> {
    this.records.delete(serializeTokenKey(key));
  }

  clear(): void {
    this.records.clear();
  }
}
