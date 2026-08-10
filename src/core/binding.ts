import type { CredentialSource } from "./credential-source";
import type { OAuthProvider, StaticTokenProvider } from "./provider";
import type { TokenStore } from "./store";

export type OAuthProviderBinding = {
  adapter: OAuthProvider;
  store: TokenStore;
  source?: never;
};

export type StoredStaticProviderBinding<TCredential = string> = {
  adapter: StaticTokenProvider<TCredential>;
  store: TokenStore;
  source?: never;
};

export type SourcedStaticProviderBinding<TCredential = string> = {
  adapter: StaticTokenProvider<TCredential>;
  source: CredentialSource<TCredential>;
  store?: never;
};

export type StaticProviderBinding<TCredential = string> =
  | StoredStaticProviderBinding<TCredential>
  | SourcedStaticProviderBinding<TCredential>;

export type ProviderBinding =
  | OAuthProviderBinding
  | StaticProviderBinding<unknown>;

export type ValidateProviderBinding<TBinding> =
  TBinding extends {
    adapter: StaticTokenProvider<infer TCredential>;
    source: CredentialSource<infer TSourceCredential>;
  }
    ? TBinding extends { store: unknown }
      ? never
      : [TSourceCredential] extends [TCredential]
        ? TBinding
        : never
    : TBinding extends {
          adapter: OAuthProvider | StaticTokenProvider<unknown>;
          store: TokenStore;
        }
      ? TBinding extends { source: unknown }
        ? never
        : TBinding
      : never;

export type ValidateProviderBindings<
  TProviders extends Readonly<Record<string, unknown>>,
> = {
  [TProvider in keyof TProviders]: ValidateProviderBinding<
    TProviders[TProvider]
  >;
};

export function isOAuthProvider(
  provider: OAuthProvider | StaticTokenProvider<unknown>,
): provider is OAuthProvider {
  return "exchangeCode" in provider && "refreshToken" in provider;
}

export function isOAuthProviderBinding(
  binding: ProviderBinding,
): binding is OAuthProviderBinding {
  return isOAuthProvider(binding.adapter);
}

export function isSourcedStaticProviderBinding(
  binding: ProviderBinding,
): binding is SourcedStaticProviderBinding<unknown> {
  return "source" in binding && binding.source !== undefined;
}
