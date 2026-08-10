import {
  assertTokenRecord,
  type StaticTokenProvider,
  type TokenKey,
  type TokenRecord,
} from "../../core";

export class RetellAIProvider implements StaticTokenProvider {
  createToken(apiKey: string, _context: { key: TokenKey }): TokenRecord {
    const token: TokenRecord = {
      accessToken: apiKey,
      lifecycle: "static",
      tokenType: "Bearer",
    };

    assertTokenRecord(token, "Retell AI API key is invalid");
    return token;
  }
}
