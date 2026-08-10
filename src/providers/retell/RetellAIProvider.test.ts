import { describe, expect, it } from "vitest";
import { InvalidTokenRecordError } from "../../core";
import { RetellAIProvider } from "./RetellAIProvider";

describe("RetellAIProvider", () => {
  const context = {
    key: { provider: "retell", accountId: "workspace-1" },
  };

  it("creates a static bearer token from a Retell API key", () => {
    const provider = new RetellAIProvider();

    expect(provider.createToken("retell-api-key", context)).toEqual({
      accessToken: "retell-api-key",
      lifecycle: "static",
      tokenType: "Bearer",
    });
  });

  it.each(["", "   "])("rejects an empty API key", (apiKey) => {
    const provider = new RetellAIProvider();

    expect(() => provider.createToken(apiKey, context)).toThrow(
      InvalidTokenRecordError,
    );
  });
});
