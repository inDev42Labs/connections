import {
  deserializeTokenRecordFromStorage,
  serializeTokenKey,
  serializeTokenRecordForStorage,
  TokenStoreError,
  type TokenKey,
  type TokenRecord,
  type TokenStore,
} from "../../core";
import type {
  ConvexTokenGetArgs,
  ConvexTokenGetResult,
  ConvexTokenStoreOptions,
} from "./convex.types";

export class ConvexTokenStore implements TokenStore {
  readonly storeName = "convex";

  private readonly options: ConvexTokenStoreOptions;

  constructor(options: ConvexTokenStoreOptions) {
    if (!options.client) {
      throw new TokenStoreError("ConvexTokenStore requires a client");
    }

    if (!options.functions?.get || !options.functions.put || !options.functions.delete) {
      throw new TokenStoreError(
        "ConvexTokenStore requires get, put, and delete function references",
      );
    }

    this.options = options;
  }

  async get(key: TokenKey): Promise<TokenRecord | null> {
    const value = getTokenData(
      await this.options.client.query<ConvexTokenGetResult>(
        this.options.functions.get,
        createTokenArgs(key),
      ),
    );

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
    const tokenData = await serializeTokenRecordForStorage({
      token,
      key,
      encryption: this.options.encryption,
      storeName: this.storeName,
    });

    await this.options.client.mutation(this.options.functions.put, {
      ...createTokenArgs(key),
      tokenData,
    });
  }

  async delete(key: TokenKey): Promise<void> {
    await this.options.client.mutation(this.options.functions.delete, createTokenArgs(key));
  }
}

function createTokenArgs(key: TokenKey): ConvexTokenGetArgs {
  return {
    tokenKey: serializeTokenKey(key),
    provider: key.provider,
    accountId: key.accountId,
    connectionId: key.connectionId ?? null,
  };
}

function getTokenData(result: ConvexTokenGetResult): string | null {
  if (typeof result === "string" || result === null) {
    return result;
  }

  if ("tokenData" in result) {
    return result.tokenData;
  }

  return result.token_data;
}
