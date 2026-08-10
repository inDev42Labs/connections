import {
  isOAuthProvider,
  isOAuthProviderBinding,
  isSourcedStaticProviderBinding,
  type OAuthProviderBinding,
  type ProviderBinding,
  type SourcedStaticProviderBinding,
  type ValidateProviderBinding,
  type ValidateProviderBindings,
} from "./binding";
import {
  InvalidTokenRecordError,
  MissingRefreshTokenError,
  OAuthProviderError,
  ProviderCapabilityError,
  ProviderNotRegisteredError,
  TokenExpiredError,
  TokenNotFoundError,
} from "./errors";
import type { AuthorizationUrlInput, ExchangeCodeInput } from "./provider";
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

export type TokenManagerOptions<
  TProviders extends Readonly<Record<string, unknown>> = Readonly<
    Record<string, ProviderBinding>
  >,
> = {
  providers?: TProviders & ValidateProviderBindings<TProviders>;
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

export type SaveCredentialInput<TCredential = unknown> = {
  key: TokenKey;
  credential: TCredential;
};

/** @deprecated Use SaveTokenInput instead. */
export type SaveInitialTokenInput = SaveTokenInput;

export type ExchangeCodeAndSaveInput = ExchangeCodeInput;

export type GetAuthorizationUrlInput = AuthorizationUrlInput;

export class TokenManager<
  const TProviders extends Readonly<Record<string, unknown>> = Readonly<
    Record<string, ProviderBinding>
  >,
> {
  private readonly bindings = new Map<string, ProviderBinding>();
  private readonly refreshLocks = new Map<string, Promise<TokenRecord>>();
  private readonly refreshSkewMs: number;
  private readonly now: () => number;
  private readonly onEvent?: (event: ConnectionsEvent) => void;

  constructor(options: TokenManagerOptions<TProviders> = {}) {
    this.refreshSkewMs = options.refreshSkewMs ?? 60_000;
    this.now = options.now ?? Date.now;
    this.onEvent = options.onEvent;

    for (const [provider, binding] of Object.entries(
      options.providers ?? {},
    ) as Array<[string, ProviderBinding]>) {
      this.bindings.set(provider, binding);
    }
  }

  use<TBinding>(
    provider: string,
    binding: TBinding & ValidateProviderBinding<TBinding>,
  ): this {
    this.bindings.set(provider, binding as ProviderBinding);
    return this;
  }

  async getAuthorizationUrl(input: GetAuthorizationUrlInput): Promise<string> {
    const binding = this.getOAuthBinding(input.key.provider, "authorizationUrl");
    return binding.adapter.getAuthorizationUrl({
      key: input.key,
      redirectUri: input.redirectUri,
      scopes: input.scopes,
      state: input.state,
      metadata: input.metadata,
    });
  }

  async exchangeCodeAndSave(
    input: ExchangeCodeAndSaveInput,
  ): Promise<TokenRecord> {
    const binding = this.getOAuthBinding(input.key.provider, "exchangeCode");
    const startedAt = this.now();
    this.emit({
      level: "debug",
      operation: "token.exchange",
      provider: input.key.provider,
      outcome: "started",
    });

    let token: unknown;
    try {
      token = await binding.adapter.exchangeCode({
        key: input.key,
        code: input.code,
        redirectUri: input.redirectUri,
        metadata: input.metadata,
      });
      assertTokenRecord(
        token,
        `${providerDisplayName(input.key.provider)} exchangeCode returned an invalid token record`,
      );
      this.emit({
        level: "info",
        operation: "token.exchange",
        provider: input.key.provider,
        outcome: "succeeded",
        durationMs: this.now() - startedAt,
      });
    } catch (error) {
      this.emitFailure(
        "token.exchange",
        input.key.provider,
        error,
        startedAt,
      );
      throw error;
    }

    await this.persist(input.key, token, binding.store);
    return token;
  }

  async saveCredential<TCredential>(
    input: SaveCredentialInput<TCredential>,
  ): Promise<void> {
    const binding = this.getBinding(input.key.provider);
    if (
      isOAuthProviderBinding(binding) ||
      isSourcedStaticProviderBinding(binding)
    ) {
      throw new ProviderCapabilityError(
        input.key.provider,
        "saveCredential",
      );
    }

    const token: unknown = binding.adapter.createToken(input.credential, {
      key: input.key,
    });
    assertTokenRecord(
      token,
      `${providerDisplayName(input.key.provider)} createToken returned an invalid token record`,
    );
    await this.persist(input.key, token, binding.store);
  }

  async saveToken(input: SaveTokenInput): Promise<void> {
    const binding = this.getBinding(input.key.provider);
    if (isSourcedStaticProviderBinding(binding)) {
      throw new ProviderCapabilityError(input.key.provider, "saveToken");
    }

    assertTokenRecord(input.token, "Token is invalid");
    await this.persist(input.key, input.token, binding.store);
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
    const binding = this.getBinding(key.provider);
    const token = await this.load(key, binding);

    if (!token) {
      throw new TokenNotFoundError();
    }

    if (!isOAuthProviderBinding(binding) || token.lifecycle === "static") {
      return this.assertStaticTokenIsCurrent(token);
    }

    if (!this.shouldRefresh(token)) {
      return token;
    }

    return this.refreshAndSave(key, token, options, binding);
  }

  async revoke(
    key: TokenKey,
    options: TokenManagerRequestOptions = {},
  ): Promise<void> {
    const binding = this.getBinding(key.provider);
    if (isSourcedStaticProviderBinding(binding)) {
      throw new ProviderCapabilityError(key.provider, "revoke");
    }

    const token = await this.loadFromStore(key, binding.store);
    if (
      token &&
      isOAuthProvider(binding.adapter) &&
      binding.adapter.revokeToken
    ) {
      await binding.adapter.revokeToken({
        key,
        token,
        metadata: options.metadata,
      });
    }

    await binding.store.delete(key);
  }

  private assertStaticTokenIsCurrent(token: TokenRecord): TokenRecord {
    if (token.expiresAt !== undefined && token.expiresAt <= this.now()) {
      throw new TokenExpiredError(token.expiresAt);
    }
    return token;
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
    binding: OAuthProviderBinding,
  ): Promise<TokenRecord> {
    const lockKey = serializeTokenKey(key);
    const existingRefresh = this.refreshLocks.get(lockKey);
    if (existingRefresh) return existingRefresh;

    const refresh = this.refreshAndPersist(
      key,
      currentToken,
      options,
      binding,
    ).finally(() => {
      this.refreshLocks.delete(lockKey);
    });
    this.refreshLocks.set(lockKey, refresh);
    return refresh;
  }

  private async refreshAndPersist(
    key: TokenKey,
    currentToken: TokenRecord,
    options: TokenManagerRequestOptions,
    binding: OAuthProviderBinding,
  ): Promise<TokenRecord> {
    if (!currentToken.refreshToken) throw new MissingRefreshTokenError();

    const provider = binding.adapter;
    const startedAt = this.now();
    this.emit({
      level: "debug",
      operation: "token.refresh",
      provider: key.provider,
      outcome: "started",
      details: { hadRefreshToken: true },
    });

    let refreshedToken: unknown;
    try {
      refreshedToken = await provider.refreshToken({
        key,
        refreshToken: currentToken.refreshToken,
        currentToken,
        metadata: options.metadata,
      });
      assertTokenRecord(
        refreshedToken,
        `${providerDisplayName(key.provider)} refreshToken returned an invalid token record`,
      );
      this.emit({
        level: "info",
        operation: "token.refresh",
        provider: key.provider,
        outcome: "succeeded",
        durationMs: this.now() - startedAt,
        details: { hadRefreshToken: true },
      });
    } catch (error) {
      this.emitFailure("token.refresh", key.provider, error, startedAt, {
        hadRefreshToken: true,
      });
      throw error;
    }

    const nextToken = {
      ...currentToken,
      ...refreshedToken,
      refreshToken: refreshedToken.refreshToken ?? currentToken.refreshToken,
    };
    assertTokenRecord(
      nextToken,
      "Refreshed token is invalid before persistence",
    );
    await this.persist(key, nextToken, binding.store);
    return nextToken;
  }

  private load(
    key: TokenKey,
    binding: ProviderBinding,
  ): Promise<TokenRecord | null> {
    if (isSourcedStaticProviderBinding(binding)) {
      return this.loadFromSource(key, binding);
    }
    return this.loadFromStore(key, binding.store);
  }

  private async loadFromSource(
    key: TokenKey,
    binding: SourcedStaticProviderBinding<unknown>,
  ): Promise<TokenRecord | null> {
    return this.observeLoad(key, async () => {
      const credential = await binding.source.get(key);
      if (credential === null) return null;

      const token: unknown = binding.adapter.createToken(credential, { key });
      assertTokenRecord(
        token,
        `${providerDisplayName(key.provider)} createToken returned an invalid token record`,
      );
      return token;
    });
  }

  private loadFromStore(
    key: TokenKey,
    store: TokenStore,
  ): Promise<TokenRecord | null> {
    return this.observeLoad(key, async () => {
      const token: unknown = await store.get(key);
      if (token !== null) {
        assertTokenRecord(token, "Token loaded from storage is invalid");
      }
      return token;
    });
  }

  private async observeLoad(
    key: TokenKey,
    load: () => Promise<TokenRecord | null>,
  ): Promise<TokenRecord | null> {
    const startedAt = this.now();
    this.emit({
      level: "debug",
      operation: "token.load",
      provider: key.provider,
      outcome: "started",
    });

    try {
      const token = await load();
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

  private async persist(
    key: TokenKey,
    token: unknown,
    store: TokenStore,
  ): Promise<void> {
    const startedAt = this.now();
    this.emit({
      level: "debug",
      operation: "token.persist",
      provider: key.provider,
      outcome: "started",
    });

    try {
      assertTokenRecord(token, "Token is invalid before persistence");
      await store.put(key, token);
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
    if (!this.onEvent) return;
    try {
      const result = (this.onEvent as (value: ConnectionsEvent) => unknown)(event);
      if (result instanceof Promise) void result.catch(() => {});
    } catch (_) {
      // Observability must never affect token handling.
    }
  }

  private getBinding(provider: string): ProviderBinding {
    const binding = this.bindings.get(provider);
    if (!binding) throw new ProviderNotRegisteredError(provider);
    return binding;
  }

  private getOAuthBinding(
    provider: string,
    capability: "authorizationUrl" | "exchangeCode",
  ): OAuthProviderBinding {
    const binding = this.getBinding(provider);
    if (!isOAuthProvider(binding.adapter)) {
      throw new ProviderCapabilityError(provider, capability);
    }
    return binding as OAuthProviderBinding;
  }
}

function providerDisplayName(provider: string): string {
  return provider.length > 0
    ? `${provider[0]!.toUpperCase()}${provider.slice(1)}`
    : "Provider";
}
