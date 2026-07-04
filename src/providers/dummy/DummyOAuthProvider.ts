import type {
  AuthorizationUrlInput,
  ExchangeCodeInput,
  OAuthProvider,
  RefreshTokenInput,
  RevokeTokenInput,
  TokenRecord,
} from "../../core";
import type { DummyOAuthProviderOptions } from "./dummy.types";

export class DummyOAuthProvider implements OAuthProvider {
  readonly provider: string;

  private readonly options: DummyOAuthProviderOptions;
  private readonly revokedTokens = new Set<string>();

  constructor(options: DummyOAuthProviderOptions = {}) {
    this.options = options;
    this.provider = options.provider ?? "dummy";
  }

  get revokedTokenCount(): number {
    return this.revokedTokens.size;
  }

  hasRevokedToken(token: string): boolean {
    return this.revokedTokens.has(token);
  }

  async getAuthorizationUrl(input: AuthorizationUrlInput): Promise<string> {
    const url = new URL(this.options.authorizationUrl ?? "https://dummy.oauth.local/authorize");
    const scopes = input.scopes ?? this.options.defaultScopes;

    url.searchParams.set("response_type", "code");
    url.searchParams.set("provider", this.provider);
    url.searchParams.set("redirect_uri", input.redirectUri);
    if (scopes?.length) {
      url.searchParams.set("scope", scopes.join(" "));
    }
    if (input.state) {
      url.searchParams.set("state", input.state);
    }

    return url.toString();
  }

  async exchangeCode(input: ExchangeCodeInput): Promise<TokenRecord> {
    return {
      accessToken: this.createToken(this.options.accessTokenPrefix ?? "dummy-access", input.code),
      refreshToken: this.createToken(this.options.refreshTokenPrefix ?? "dummy-refresh", input.code),
      tokenType: this.options.tokenType ?? "Bearer",
      expiresAt: this.expiresAt(),
      metadata: {
        provider: this.provider,
        code: input.code,
        redirectUri: input.redirectUri,
      },
    };
  }

  async refreshToken(input: RefreshTokenInput): Promise<TokenRecord> {
    return {
      accessToken: this.createToken(
        this.options.refreshedAccessTokenPrefix ?? "dummy-refreshed-access",
        input.refreshToken,
      ),
      tokenType: this.options.tokenType ?? input.currentToken?.tokenType ?? "Bearer",
      expiresAt: this.expiresAt(),
      metadata: {
        ...(input.currentToken?.metadata ?? {}),
        refreshed: true,
      },
    };
  }

  async revokeToken(input: RevokeTokenInput): Promise<void> {
    this.revokedTokens.add(input.token.refreshToken ?? input.token.accessToken);
  }

  private createToken(prefix: string, value: string): string {
    return `${prefix}-${encodeURIComponent(value)}`;
  }

  private expiresAt(): number | undefined {
    const expiresInMs = this.options.expiresInMs ?? 3_600_000;

    if (expiresInMs <= 0) {
      return undefined;
    }

    return (this.options.now ?? Date.now)() + expiresInMs;
  }
}
