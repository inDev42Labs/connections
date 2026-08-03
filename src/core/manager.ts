import {
  InvalidTokenRecordError,
  MissingRefreshTokenError,
  OAuthProviderError,
  OAuthProviderNotRegisteredError,
  TokenExpiredError,
  TokenNotFoundError,
} from "./errors";
import type {
  AuthorizationUrlInput,
  ExchangeCodeInput,
  OAuthProvider,
} from "./provider";
import { serializeTokenKey, type TokenStore } from "./store";
import { assertTokenRecord } from "./token-record";
import type { TokenKey, TokenRecord } from "./types";

export type ConnectionsEvent = {
  level: "debug" | "info" | "warn" | "error";
  operation:
    | "token.exchange"
    | "token.refresh"
    | "token.load"
    | "token.persist";
  provider: string;
  outcome: "started" | "succeeded" | "failed";
  status?: number;
  errorCode?: string;
  durationMs?: number;
  details?: Record<string, unknown>;
};

export type TokenManagerOptions = {
  store: TokenStore;
  providers?: OAuthProvider[];
  refreshSkewMs?: number;
  now?: () => number;
  onEvent?: (event: ConnectionsEvent) => void;
};

export type TokenManagerRequestOptions = {
  metadata?: Record<string, unknown>;
};

export type SaveTokenInput = {
  key: TokenKey;
  token: TokenRecord;
};

/** @deprecated Use SaveTokenInput instead. */
export type SaveInitialTokenInput = SaveTokenInput;

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
  private readonly onEvent?: (event: ConnectionsEvent) => void;
  private readonly store: TokenStore;

  constructor(options: TokenManagerOptions) {
    this.store = options.store;
    this.refreshSkewMs = options.refreshSkewMs ?? 60_000;
    this.now = options.now ?? Date.now;
    this.onEvent = options.onEvent;

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
    const startedAt = this.now();
    this.emit({
      level: "debug",
      operation: "token.exchange",
      provider: provider.provider,
      outcome: "started",
    });

    let token: unknown;
    try {
      token = await provider.exchangeCode({
        code: input.code,
        redirectUri: input.redirectUri,
        metadata: input.metadata,
      });
      assertTokenRecord(
        token,
        `${providerDisplayName(provider.provider)} exchangeCode returned an invalid token record`,
      );
      this.emit({
        level: "info",
        operation: "token.exchange",
        provider: provider.provider,
        outcome: "succeeded",
        durationMs: this.now() - startedAt,
      });
    } catch (error) {
      this.emitFailure("token.exchange", provider.provider, error, startedAt);
      throw error;
    }

    await this.persist(input.key, token);
    return token;
  }

  async saveToken(input: SaveTokenInput): Promise<void> {
    assertTokenRecord(input.token, "Token is invalid");
    await this.persist(input.key, input.token);
  }

  /** @deprecated Use saveToken instead. */
  async saveInitialToken(input: SaveInitialTokenInput): Promise<void> {
    return this.saveToken(input);
  }

  async getValidAccessToken(
    key: TokenKey,
    options: TokenManagerRequestOptions = {},
  ): Promise<string> {
    const token = await this.getValidToken(key, options);
    assertTokenRecord(token, "Token returned by getValidAccessToken is invalid");
    return token.accessToken;
  }

  async getValidToken(
    key: TokenKey,
    options: TokenManagerRequestOptions = {},
  ): Promise<TokenRecord> {
    const token = await this.load(key);

    if (!token) {
      throw new TokenNotFoundError();
    }

    if (token.lifecycle === "static") {
      if (token.expiresAt !== undefined && token.expiresAt <= this.now()) {
        throw new TokenExpiredError(token.expiresAt);
      }
      return token;
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
    const token = await this.load(key);
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
    const startedAt = this.now();
    this.emit({
      level: "debug",
      operation: "token.refresh",
      provider: provider.provider,
      outcome: "started",
      details: { hadRefreshToken: true },
    });

    let refreshedToken: unknown;
    try {
      refreshedToken = await provider.refreshToken({
        refreshToken: currentToken.refreshToken,
        currentToken,
        metadata: options.metadata,
      });
      assertTokenRecord(
        refreshedToken,
        `${providerDisplayName(provider.provider)} refreshToken returned an invalid token record`,
      );
      this.emit({
        level: "info",
        operation: "token.refresh",
        provider: provider.provider,
        outcome: "succeeded",
        durationMs: this.now() - startedAt,
        details: { hadRefreshToken: true },
      });
    } catch (error) {
      this.emitFailure("token.refresh", provider.provider, error, startedAt, {
        hadRefreshToken: true,
      });
      throw error;
    }

    const nextToken = {
      ...currentToken,
      ...refreshedToken,
      refreshToken: refreshedToken.refreshToken ?? currentToken.refreshToken,
    };

    assertTokenRecord(nextToken, "Refreshed token is invalid before persistence");
    await this.persist(key, nextToken);
    return nextToken;
  }

  private async load(key: TokenKey): Promise<TokenRecord | null> {
    const startedAt = this.now();
    this.emit({
      level: "debug",
      operation: "token.load",
      provider: key.provider,
      outcome: "started",
    });

    try {
      const token: unknown = await this.store.get(key);
      if (token !== null) {
        assertTokenRecord(token, "Token loaded from storage is invalid");
      }
      this.emit({
        level: "debug",
        operation: "token.load",
        provider: key.provider,
        outcome: "succeeded",
        durationMs: this.now() - startedAt,
      });
      return token;
    } catch (error) {
      this.emitFailure("token.load", key.provider, error, startedAt);
      throw error;
    }
  }

  private async persist(key: TokenKey, token: unknown): Promise<void> {
    const startedAt = this.now();
    this.emit({
      level: "debug",
      operation: "token.persist",
      provider: key.provider,
      outcome: "started",
    });

    try {
      assertTokenRecord(token, "Token is invalid before persistence");
      await this.store.put(key, token);
      this.emit({
        level: "info",
        operation: "token.persist",
        provider: key.provider,
        outcome: "succeeded",
        durationMs: this.now() - startedAt,
      });
    } catch (error) {
      this.emitFailure("token.persist", key.provider, error, startedAt);
      throw error;
    }
  }

  private emitFailure(
    operation: ConnectionsEvent["operation"],
    provider: string,
    error: unknown,
    startedAt: number,
    details: Record<string, unknown> = {},
  ): void {
    const event: ConnectionsEvent = {
      level: "error",
      operation,
      provider,
      outcome: "failed",
      durationMs: this.now() - startedAt,
    };

    if (error instanceof OAuthProviderError) {
      event.status = error.status;
      event.errorCode = error.oauthErrorCode ?? error.code;
      event.details = {
        ...details,
        ...error.details,
        ...(error.cause !== undefined
          ? {
              causeName:
                error.cause instanceof Error
                  ? error.cause.name
                  : typeof error.cause,
            }
          : {}),
      };
    } else if (error instanceof InvalidTokenRecordError) {
      event.errorCode = error.code;
      event.details = { ...details, invalidFields: error.fields };
    } else {
      event.details = {
        ...details,
        causeName: error instanceof Error ? error.name : typeof error,
      };
    }

    this.emit(event);
  }

  private emit(event: ConnectionsEvent): void {
    if (!this.onEvent) {
      return;
    }

    try {
      const result = (this.onEvent as (value: ConnectionsEvent) => unknown)(event);
      if (result instanceof Promise) {
        void result.catch(() => {});
      }
    } catch (_) {
      // Observability must never affect token handling.
    }
  }

  private getProvider(providerName: string): OAuthProvider {
    const provider = this.providers.get(providerName);

    if (!provider) {
      throw new OAuthProviderNotRegisteredError(providerName);
    }

    return provider;
  }
}

function providerDisplayName(provider: string): string {
  return provider.length > 0
    ? `${provider[0]!.toUpperCase()}${provider.slice(1)}`
    : "Provider";
}
