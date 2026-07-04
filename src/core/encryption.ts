import type { TokenKey, TokenRecord } from "./types";

export type TokenEncryptionContext = {
  key: TokenKey;
  storeName?: string;
};

export interface TokenEncryption {
  encrypt(input: {
    plaintext: string;
    context: TokenEncryptionContext;
  }): Promise<string>;

  decrypt(input: {
    ciphertext: string;
    context: TokenEncryptionContext;
  }): Promise<string>;
}

export class PlaintextTokenEncryption implements TokenEncryption {
  async encrypt(input: {
    plaintext: string;
    context: TokenEncryptionContext;
  }): Promise<string> {
    return input.plaintext;
  }

  async decrypt(input: {
    ciphertext: string;
    context: TokenEncryptionContext;
  }): Promise<string> {
    return input.ciphertext;
  }
}

export const plaintextTokenEncryption = new PlaintextTokenEncryption();

export async function serializeTokenRecordForStorage(input: {
  token: TokenRecord;
  key: TokenKey;
  encryption?: TokenEncryption;
  storeName?: string;
}): Promise<string> {
  const encryption = input.encryption ?? plaintextTokenEncryption;

  return encryption.encrypt({
    plaintext: JSON.stringify(input.token),
    context: {
      key: input.key,
      storeName: input.storeName,
    },
  });
}

export async function deserializeTokenRecordFromStorage(input: {
  value: string;
  key: TokenKey;
  encryption?: TokenEncryption;
  storeName?: string;
}): Promise<TokenRecord> {
  const encryption = input.encryption ?? plaintextTokenEncryption;
  const plaintext = await encryption.decrypt({
    ciphertext: input.value,
    context: {
      key: input.key,
      storeName: input.storeName,
    },
  });

  return JSON.parse(plaintext) as TokenRecord;
}
