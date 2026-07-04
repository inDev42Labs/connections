export type AesGcmTokenEncryptionKeyEncoding = "base64" | "base64url" | "utf8";

export type AesGcmTokenEncryptionOptions = {
  key: CryptoKey | ArrayBuffer | Uint8Array | string;
  keyEncoding?: AesGcmTokenEncryptionKeyEncoding;
};
