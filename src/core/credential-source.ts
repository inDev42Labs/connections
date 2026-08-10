import type { Awaitable, TokenKey } from "./types";

/** A read-only source of externally managed, provider-specific credentials. */
export interface CredentialSource<TCredential> {
  readonly sourceName?: string;

  get(key: TokenKey): Awaitable<TCredential | null>;
}
