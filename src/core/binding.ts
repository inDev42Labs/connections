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

export function bindOAuthProvider(
  adapter: OAuthProvider,
  store: TokenStore,
): OAuthProviderBinding {
  return { adapter, store };
}

export function bindStaticProvider<TCredential>(
  adapter: StaticTokenProvider<TCredential>,
  storage: { store: TokenStore },
): StoredStaticProviderBinding<TCredential>;
export function bindStaticProvider<TCredential>(
  adapter: StaticTokenProvider<TCredential>,
  storage: { source: CredentialSource<NoInfer<TCredential>> },
): SourcedStaticProviderBinding<TCredential>;
export function bindStaticProvider<TCredential>(
  adapter: StaticTokenProvider<TCredential>,
  storage:
    | { store: TokenStore }
    | { source: CredentialSource<NoInfer<TCredential>> },
): StaticProviderBinding<TCredential> {
  return { adapter, ...storage } as StaticProviderBinding<TCredential>;
}

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
