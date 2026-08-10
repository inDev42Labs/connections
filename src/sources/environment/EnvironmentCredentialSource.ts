import type { CredentialSource, TokenKey } from "../../core";
import type { EnvironmentCredentialSourceOptions } from "./environment.types";

export class EnvironmentCredentialSource
  implements CredentialSource<string>
{
  readonly sourceName: string;
  private readonly key: EnvironmentCredentialSourceOptions["key"];
  private readonly runtimeEnv: EnvironmentCredentialSourceOptions["runtimeEnv"];

  constructor(options: EnvironmentCredentialSourceOptions) {
    this.key = options.key;
    this.runtimeEnv = options.runtimeEnv;
    this.sourceName = options.sourceName ?? "environment";
  }

  get(tokenKey: TokenKey): string | null {
    const key = typeof this.key === "function" ? this.key(tokenKey) : this.key;
    return this.runtimeEnv[key] ?? null;
  }
}
