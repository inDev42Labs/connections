import type { TokenKey } from "../../core";

export type EnvironmentValues = Readonly<Record<string, string | undefined>>;

export type EnvironmentCredentialSourceOptions = {
  runtimeEnv: EnvironmentValues;
  key: string | ((tokenKey: TokenKey) => string);
  sourceName?: string;
};
