import {
  assertTokenRecord,
  type StaticTokenProvider,
  type TokenRecord,
} from "../../core";

export class RetellAIProvider implements StaticTokenProvider {
  readonly provider = "retell";

  createToken(apiKey: string): TokenRecord {
    const token: TokenRecord = {
      accessToken: apiKey,
      lifecycle: "static",
      tokenType: "Bearer",
    };

    assertTokenRecord(token, "Retell AI API key is invalid");
    return token;
  }
}
