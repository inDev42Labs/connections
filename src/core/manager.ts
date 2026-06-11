import {
  MissingRefreshTokenError,
  OAuthProviderNotRegisteredError,
  TokenNotFoundError,
} from "./errors";
import type {
  AuthorizationUrlInput,
  ExchangeCodeInput,
  OAuthProvider,
} from "./provider";
import { serializeTokenKey, type TokenStore } from "./store";
import type { TokenKey, TokenRecord } from "./types";

export type TokenManagerOptions = {
  store: TokenStore;
  providers?: OAuthProvider[];
  refreshSkewMs?: number;
  now?: () => number;
};

export type TokenManagerRequestOptions = {
  metadata?: Record<string, unknown>;
};

export type SaveInitialTokenInput = {
  key: TokenKey;
  token: TokenRecord;
};

export type ExchangeCodeAndSaveInput = ExchangeCodeInput & {
  key: TokenKey;
};

export type GetAuthorizationUrlInput = AuthorizationUrlInput & {
  key: TokenKey;
};

export class TokenManager {
  private readonly providers = new Map<string, OAuthProvider>();
  private readonly refreshLocks = new Map<string, Promise<TokenRecord>>();
  private readonly refreshSkewMs: number;
  private readonly now: () => number;
  private readonly store: TokenStore;

  constructor(options: TokenManagerOptions) {
    this.store = options.store;
    this.refreshSkewMs = options.refreshSkewMs ?? 60_000;
    this.now = options.now ?? Date.now;

    for (const provider of options.providers ?? []) {
      this.use(provider);
    }
  }

  use(provider: OAuthProvider): this {
    this.providers.set(provider.provider, provider);
    return this;
  }

  async getAuthorizationUrl(input: GetAuthorizationUrlInput): Promise<string> {
    const provider = this.getProvider(input.key.provider);
    return provider.getAuthorizationUrl(input);
  }

  async exchangeCodeAndSave(
    input: ExchangeCodeAndSaveInput,
  ): Promise<TokenRecord> {
    const provider = this.getProvider(input.key.provider);
    const token = await provider.exchangeCode({
      code: input.code,
      redirectUri: input.redirectUri,
      metadata: input.metadata,
    });

    await this.store.put(input.key, token);
    return token;
  }

  async saveInitialToken(input: SaveInitialTokenInput): Promise<void> {
    await this.store.put(input.key, input.token);
  }

  async getValidAccessToken(
    key: TokenKey,
    options: TokenManagerRequestOptions = {},
  ): Promise<string> {
    const token = await this.getValidToken(key, options);
    return token.accessToken;
  }

  async getValidToken(
    key: TokenKey,
    options: TokenManagerRequestOptions = {},
  ): Promise<TokenRecord> {
    const token = await this.store.get(key);

    if (!token) {
      throw new TokenNotFoundError();
    }

    if (!this.shouldRefresh(token)) {
      return token;
    }

    return this.refreshAndSave(key, token, options);
  }

  async revoke(
    key: TokenKey,
    options: TokenManagerRequestOptions = {},
  ): Promise<void> {
    const token = await this.store.get(key);
    const provider = this.providers.get(key.provider);

    if (token && provider?.revokeToken) {
      await provider.revokeToken({
        token,
        metadata: options.metadata,
      });
    }

    await this.store.delete(key);
  }

  private shouldRefresh(token: TokenRecord): boolean {
    return (
      token.expiresAt !== undefined &&
      token.expiresAt <= this.now() + this.refreshSkewMs
    );
  }

  private refreshAndSave(
    key: TokenKey,
    currentToken: TokenRecord,
    options: TokenManagerRequestOptions,
  ): Promise<TokenRecord> {
    const lockKey = serializeTokenKey(key);
    const existingRefresh = this.refreshLocks.get(lockKey);

    if (existingRefresh) {
      return existingRefresh;
    }

    const refresh = this.refreshAndPersist(key, currentToken, options).finally(
      () => {
        this.refreshLocks.delete(lockKey);
      },
    );

    this.refreshLocks.set(lockKey, refresh);
    return refresh;
  }

  private async refreshAndPersist(
    key: TokenKey,
    currentToken: TokenRecord,
    options: TokenManagerRequestOptions,
  ): Promise<TokenRecord> {
    if (!currentToken.refreshToken) {
      throw new MissingRefreshTokenError();
    }

    const provider = this.getProvider(key.provider);
    const refreshedToken = await provider.refreshToken({
      refreshToken: currentToken.refreshToken,
      currentToken,
      metadata: options.metadata,
    });

    const nextToken = {
      ...currentToken,
      ...refreshedToken,
      refreshToken: refreshedToken.refreshToken ?? currentToken.refreshToken,
    };

    await this.store.put(key, nextToken);
    return nextToken;
  }

  private getProvider(providerName: string): OAuthProvider {
    const provider = this.providers.get(providerName);

    if (!provider) {
      throw new OAuthProviderNotRegisteredError(providerName);
    }

    return provider;
  }
}
