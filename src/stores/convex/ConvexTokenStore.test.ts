import { describe, expect, it, vi } from "vitest";
import {
  serializeTokenKey,
  TokenStoreError,
  type TokenEncryption,
  type TokenKey,
  type TokenRecord,
} from "../../core";
import { ConvexTokenStore } from "./ConvexTokenStore";
import type { ConvexClient } from "./convex.types";

type ConvexCall = {
  functionReference: unknown;
  args: unknown;
};

const functions = {
  get: "tokens:get",
  put: "tokens:put",
  delete: "tokens:delete",
};

const key: TokenKey = {
  provider: "zoho",
  accountId: "account-1",
  connectionId: "connection-1",
};

const token: TokenRecord = {
  accessToken: "access-token",
  refreshToken: "refresh-token",
  expiresAt: 1_000,
};

describe("ConvexTokenStore", () => {
  it("requires a client", () => {
    expect(
      () => new ConvexTokenStore({ functions, client: undefined as never }),
    ).toThrow(TokenStoreError);
  });

  it("requires all function references", () => {
    const client = new StatefulConvexClient();

    expect(
      () =>
        new ConvexTokenStore({
          client,
          functions: { get: functions.get, put: functions.put } as never,
        }),
    ).toThrow("ConvexTokenStore requires get, put, and delete function references");
  });

  it("returns null when no record exists", async () => {
    const client = new StatefulConvexClient();
    const store = new ConvexTokenStore({ client, functions });

    await expect(store.get(key)).resolves.toBeNull();
  });

  it("round-trips put then get then delete through Convex functions", async () => {
    const client = new StatefulConvexClient();
    const store = new ConvexTokenStore({ client, functions });

    await store.put(key, token);
    await expect(store.get(key)).resolves.toEqual(token);
    await store.delete(key);
    await expect(store.get(key)).resolves.toBeNull();
  });

  it("passes stable token args and function references", async () => {
    const client = new StatefulConvexClient();
    const store = new ConvexTokenStore({ client, functions });

    await store.put(key, token);
    await store.get(key);
    await store.delete(key);

    expect(client.mutationCalls[0]).toEqual({
      functionReference: functions.put,
      args: {
        tokenKey: serializeTokenKey(key),
        provider: key.provider,
        accountId: key.accountId,
        connectionId: key.connectionId,
        tokenData: JSON.stringify(token),
      },
    });
    expect(client.queryCalls[0]).toEqual({
      functionReference: functions.get,
      args: {
        tokenKey: serializeTokenKey(key),
        provider: key.provider,
        accountId: key.accountId,
        connectionId: key.connectionId,
      },
    });
    expect(client.mutationCalls[1]).toEqual({
      functionReference: functions.delete,
      args: {
        tokenKey: serializeTokenKey(key),
        provider: key.provider,
        accountId: key.accountId,
        connectionId: key.connectionId,
      },
    });
  });

  it("supports get functions that return an object with tokenData", async () => {
    const client = new FakeConvexClient({ getResult: { tokenData: JSON.stringify(token) } });
    const store = new ConvexTokenStore({ client, functions });

    await expect(store.get(key)).resolves.toEqual(token);
  });

  it("supports get functions that return an object with token_data", async () => {
    const client = new FakeConvexClient({ getResult: { token_data: JSON.stringify(token) } });
    const store = new ConvexTokenStore({ client, functions });

    await expect(store.get(key)).resolves.toEqual(token);
  });

  it("stores encrypted token data", async () => {
    const encryption: TokenEncryption = {
      encrypt: vi.fn(async () => "not-json-token-data"),
      decrypt: vi.fn(async () => JSON.stringify(token)),
    };
    const client = new StatefulConvexClient();
    const store = new ConvexTokenStore({ client, functions, encryption });

    await store.put(key, token);

    const storedTokenData = client.getStoredTokenData(key);
    expect(storedTokenData).toBe("not-json-token-data");
    expect(() => JSON.parse(storedTokenData ?? "")).toThrow();
  });

  it("does not call put mutation when encryption fails", async () => {
    const encryption: TokenEncryption = {
      encrypt: vi.fn(async () => {
        throw new Error("encrypt failed");
      }),
      decrypt: vi.fn(async () => JSON.stringify(token)),
    };
    const client = new StatefulConvexClient();
    const store = new ConvexTokenStore({ client, functions, encryption });

    await expect(store.put(key, token)).rejects.toThrow("encrypt failed");
    expect(client.mutationCalls).toEqual([]);
  });

  it("surfaces decryption failures during get", async () => {
    const encryption: TokenEncryption = {
      encrypt: vi.fn(async () => "ciphertext"),
      decrypt: vi.fn(async () => {
        throw new Error("decrypt failed");
      }),
    };
    const client = new FakeConvexClient({ getResult: "ciphertext" });
    const store = new ConvexTokenStore({ client, functions, encryption });

    await expect(store.get(key)).rejects.toThrow("decrypt failed");
  });
});

class FakeConvexClient implements ConvexClient {
  readonly queryCalls: ConvexCall[] = [];
  readonly mutationCalls: ConvexCall[] = [];
  private readonly getResult: unknown;

  constructor(options: { getResult?: unknown } = {}) {
    this.getResult = options.getResult ?? null;
  }

  async query<Result = unknown>(functionReference: unknown, args: unknown): Promise<Result> {
    this.queryCalls.push({ functionReference, args });
    return this.getResult as Result;
  }

  async mutation<Result = unknown>(
    functionReference: unknown,
    args: unknown,
  ): Promise<Result> {
    this.mutationCalls.push({ functionReference, args });
    return undefined as Result;
  }
}

class StatefulConvexClient extends FakeConvexClient {
  private readonly records = new Map<string, string>();

  getStoredTokenData(tokenKey: TokenKey): string | undefined {
    return this.records.get(serializeTokenKey(tokenKey));
  }

  override async query<Result = unknown>(
    functionReference: unknown,
    args: unknown,
  ): Promise<Result> {
    this.queryCalls.push({ functionReference, args });
    return (this.records.get(getTokenKeyArg(args)) ?? null) as Result;
  }

  override async mutation<Result = unknown>(
    functionReference: unknown,
    args: unknown,
  ): Promise<Result> {
    this.mutationCalls.push({ functionReference, args });

    if (functionReference === functions.put) {
      this.records.set(getTokenKeyArg(args), getTokenDataArg(args));
    }

    if (functionReference === functions.delete) {
      this.records.delete(getTokenKeyArg(args));
    }

    return undefined as Result;
  }
}

function getTokenKeyArg(args: unknown): string {
  if (!args || typeof args !== "object" || !("tokenKey" in args)) {
    throw new Error("Missing tokenKey arg");
  }

  return String(args.tokenKey);
}

function getTokenDataArg(args: unknown): string {
  if (!args || typeof args !== "object" || !("tokenData" in args)) {
    throw new Error("Missing tokenData arg");
  }

  return String(args.tokenData);
}
