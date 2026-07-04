import type { TokenEncryption, TokenEncryptionContext } from "../../core";
import type {
  AesGcmTokenEncryptionKeyEncoding,
  AesGcmTokenEncryptionOptions,
} from "./aes-gcm.types";

const CIPHERTEXT_VERSION = "v1";
const IV_BYTES = 12;
const AES_GCM_KEY_BYTES = new Set([16, 24, 32]);

export class AesGcmTokenEncryption implements TokenEncryption {
  private readonly keyPromise: Promise<CryptoKey>;

  constructor(options: AesGcmTokenEncryptionOptions) {
    this.keyPromise = resolveCryptoKey(options.key, options.keyEncoding ?? "base64url");
  }

  async encrypt(input: {
    plaintext: string;
    context: TokenEncryptionContext;
  }): Promise<string> {
    const iv = getCrypto().getRandomValues(new Uint8Array(new ArrayBuffer(IV_BYTES)));
    const ciphertext = await getCrypto().subtle.encrypt(
      {
        name: "AES-GCM",
        iv,
        additionalData: toArrayBuffer(encodeContext(input.context)),
      },
      await this.keyPromise,
      toArrayBuffer(new TextEncoder().encode(input.plaintext)),
    );

    return [
      CIPHERTEXT_VERSION,
      encodeBase64Url(iv),
      encodeBase64Url(new Uint8Array(ciphertext)),
    ].join(".");
  }

  async decrypt(input: {
    ciphertext: string;
    context: TokenEncryptionContext;
  }): Promise<string> {
    const [version, encodedIv, encodedCiphertext, extra] = input.ciphertext.split(".");
    if (
      version !== CIPHERTEXT_VERSION ||
      !encodedIv ||
      !encodedCiphertext ||
      extra !== undefined
    ) {
      throw new Error("Invalid AES-GCM token ciphertext");
    }

    const plaintext = await getCrypto().subtle.decrypt(
      {
        name: "AES-GCM",
        iv: toArrayBuffer(decodeBase64Url(encodedIv)),
        additionalData: toArrayBuffer(encodeContext(input.context)),
      },
      await this.keyPromise,
      toArrayBuffer(decodeBase64Url(encodedCiphertext)),
    );

    return new TextDecoder().decode(plaintext);
  }
}

async function resolveCryptoKey(
  key: AesGcmTokenEncryptionOptions["key"],
  keyEncoding: AesGcmTokenEncryptionKeyEncoding,
): Promise<CryptoKey> {
  if (isCryptoKey(key)) {
    return key;
  }

  const rawKey = normalizeRawKey(key, keyEncoding);
  if (!AES_GCM_KEY_BYTES.has(rawKey.byteLength)) {
    throw new Error("AES-GCM token encryption key must be 16, 24, or 32 bytes");
  }

  return getCrypto().subtle.importKey("raw", toArrayBuffer(rawKey), "AES-GCM", false, [
    "encrypt",
    "decrypt",
  ]);
}

function normalizeRawKey(
  key: ArrayBuffer | Uint8Array | string,
  keyEncoding: AesGcmTokenEncryptionKeyEncoding,
): Uint8Array {
  if (typeof key === "string") {
    if (keyEncoding === "utf8") {
      return new TextEncoder().encode(key);
    }

    return decodeBase64(key, keyEncoding);
  }

  if (key instanceof Uint8Array) {
    return key;
  }

  return new Uint8Array(key);
}

function isCryptoKey(key: unknown): key is CryptoKey {
  return (
    typeof key === "object" &&
    key !== null &&
    Object.prototype.toString.call(key) === "[object CryptoKey]"
  );
}

function getCrypto(): Crypto {
  if (!globalThis.crypto?.subtle) {
    throw new Error("AES-GCM token encryption requires Web Crypto support");
  }

  return globalThis.crypto;
}

function encodeContext(context: TokenEncryptionContext): Uint8Array {
  return new TextEncoder().encode(
    JSON.stringify({
      key: {
        provider: context.key.provider,
        accountId: context.key.accountId,
        connectionId: context.key.connectionId ?? null,
      },
      storeName: context.storeName ?? null,
    }),
  );
}

function encodeBase64Url(bytes: Uint8Array): string {
  return bytesToBase64(bytes)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
}

function decodeBase64(value: string, encoding: "base64" | "base64url"): Uint8Array {
  if (encoding === "base64") {
    return base64ToBytes(value);
  }

  return decodeBase64Url(value);
}

function decodeBase64Url(value: string): Uint8Array {
  const base64 = value.replaceAll("-", "+").replaceAll("_", "/");
  return base64ToBytes(base64.padEnd(base64.length + ((4 - (base64.length % 4)) % 4), "="));
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }

  return btoa(binary);
}

function base64ToBytes(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }

  return bytes;
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}
