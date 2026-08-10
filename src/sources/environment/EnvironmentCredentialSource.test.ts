import { describe, expect, it } from "vitest";
import type { TokenKey } from "../../core";
import { EnvironmentCredentialSource } from "./EnvironmentCredentialSource";

const key: TokenKey = { provider: "retell", accountId: "workspace-1" };

describe("EnvironmentCredentialSource", () => {
  it("returns the raw value from a fixed environment key", async () => {
    const source = new EnvironmentCredentialSource({
      key: "RETELL_API_KEY",
      runtimeEnv: { RETELL_API_KEY: "raw-api-key" },
    });

    expect(source.get(key)).toBe("raw-api-key");
  });

  it("resolves an environment key from the token key", async () => {
    const source = new EnvironmentCredentialSource({
      key: (tokenKey) => `RETELL_API_KEY_${tokenKey.accountId}`,
      runtimeEnv: { "RETELL_API_KEY_workspace-1": "account-api-key" },
    });

    expect(source.get(key)).toBe("account-api-key");
  });

  it("returns null when the environment key is missing", async () => {
    const source = new EnvironmentCredentialSource({
      key: "RETELL_API_KEY",
      runtimeEnv: {},
    });

    expect(source.get(key)).toBeNull();
  });

  it("does not trim or otherwise transform a raw value", async () => {
    const source = new EnvironmentCredentialSource({
      key: "RETELL_API_KEY",
      runtimeEnv: { RETELL_API_KEY: "  raw-api-key  " },
    });

    expect(source.get(key)).toBe("  raw-api-key  ");
  });
});
