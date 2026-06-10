import { describe, expect, it, vi } from "vitest";
import {
  serializeTokenKey,
  TokenStoreError,
  type TokenEncryption,
  type TokenKey,
  type TokenRecord,
} from "../../core";
import { NeonTokenStore } from "./NeonTokenStore";
import type { NeonQueryResult, NeonSqlClient } from "./neon.types";

type QueryCall = {
  query: string;
  params?: unknown[];
};

type TokenDataRow = {
  token_data: string;
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

describe("NeonTokenStore", () => {
  it("automatically creates the schema before get", async () => {
    const sql = new FakeNeonSql();
    const store = new NeonTokenStore({ sql });

    await store.get(key);

    expect(normalizeSql(sql.calls[0]?.query)).toContain(
      'CREATE TABLE IF NOT EXISTS "oauth_tokens"',
    );
    expect(normalizeSql(sql.calls[1]?.query)).toContain(
      'SELECT token_data FROM "oauth_tokens"',
    );
  });

  it("automatically creates the schema before put", async () => {
    const sql = new FakeNeonSql();
    const store = new NeonTokenStore({ sql });

    await store.put(key, token);

    expect(normalizeSql(sql.calls[0]?.query)).toContain(
      'CREATE TABLE IF NOT EXISTS "oauth_tokens"',
    );
    expect(normalizeSql(sql.calls[1]?.query)).toContain(
      'INSERT INTO "oauth_tokens"',
    );
  });

  it("automatically creates the schema before delete", async () => {
    const sql = new FakeNeonSql();
    const store = new NeonTokenStore({ sql });

    await store.delete(key);

    expect(normalizeSql(sql.calls[0]?.query)).toContain(
      'CREATE TABLE IF NOT EXISTS "oauth_tokens"',
    );
    expect(normalizeSql(sql.calls[1]?.query)).toContain(
      'DELETE FROM "oauth_tokens"',
    );
  });

  it("does not create the schema when ensureSchema is false", async () => {
    const sql = new FakeNeonSql();
    const store = new NeonTokenStore({ sql, ensureSchema: false });

    await store.get(key);

    expect(sql.calls).toHaveLength(1);
    expect(normalizeSql(sql.calls[0]?.query)).toContain(
      'SELECT token_data FROM "oauth_tokens"',
    );
  });

  it("creates schema and table only once across repeated operations", async () => {
    const sql = new FakeNeonSql();
    const store = new NeonTokenStore({ sql });

    await store.get(key);
    await store.put(key, token);
    await store.delete(key);

    expect(
      sql.calls.filter((call) => call.query.includes("CREATE TABLE IF NOT EXISTS")),
    ).toHaveLength(1);
  });

  it("retries schema creation after an earlier schema creation failure", async () => {
    const sql = new FailOnceSchemaSql();
    const store = new NeonTokenStore({ sql });

    await expect(store.get(key)).rejects.toThrow("schema creation failed");
    await expect(store.get(key)).resolves.toBeNull();

    expect(
      sql.calls.filter((call) => call.query.includes("CREATE TABLE IF NOT EXISTS")),
    ).toHaveLength(2);
  });

  it("creates the configured schema when schemaName is provided", async () => {
    const sql = new FakeNeonSql();
    const store = new NeonTokenStore({ sql, schemaName: "auth" });

    await store.get(key);

    expect(normalizeSql(sql.calls[0]?.query)).toContain(
      'CREATE SCHEMA IF NOT EXISTS "auth"',
    );
    expect(normalizeSql(sql.calls[1]?.query)).toContain(
      'CREATE TABLE IF NOT EXISTS "auth"."oauth_tokens"',
    );
  });

  it("uses the configured table name", async () => {
    const sql = new FakeNeonSql();
    const store = new NeonTokenStore({ sql, tableName: "connection_tokens" });

    await store.get(key);

    expect(sql.calls.some((call) => call.query.includes('"connection_tokens"'))).toBe(
      true,
    );
  });

  it("rejects unsafe schema names", () => {
    const sql = new FakeNeonSql();

    expect(() => new NeonTokenStore({ sql, schemaName: "auth;drop" })).toThrow(
      TokenStoreError,
    );
  });

  it("rejects unsafe table names", () => {
    const sql = new FakeNeonSql();

    expect(() => new NeonTokenStore({ sql, tableName: "tokens;drop" })).toThrow(
      TokenStoreError,
    );
  });

  it("returns null when no row exists", async () => {
    const sql = new FakeNeonSql();
    const store = new NeonTokenStore({ sql });

    await expect(store.get(key)).resolves.toBeNull();
  });

  it("deserializes token_data when a row exists", async () => {
    const sql = new FakeNeonSql({
      selectResult: [{ token_data: JSON.stringify(token) }],
    });
    const store = new NeonTokenStore({ sql });

    await expect(store.get(key)).resolves.toEqual(token);
  });

  it("upserts token data using the structured token key", async () => {
    const sql = new FakeNeonSql();
    const store = new NeonTokenStore({ sql });

    await store.put(key, token);

    const insert = findCall(sql.calls, "INSERT INTO");
    expect(insert?.params).toEqual([
      serializeTokenKey(key),
      "zoho",
      "account-1",
      "connection-1",
      JSON.stringify(token),
    ]);
  });

  it("stores provider, accountId, and connectionId as queryable columns", async () => {
    const sql = new FakeNeonSql();
    const store = new NeonTokenStore({ sql });

    await store.put(key, token);

    const insert = findCall(sql.calls, "INSERT INTO");

    expect(insert?.params?.[1]).toBe("zoho");
    expect(insert?.params?.[2]).toBe("account-1");
    expect(insert?.params?.[3]).toBe("connection-1");
  });

  it("stores null connection_id when connectionId is omitted", async () => {
    const sql = new FakeNeonSql();
    const store = new NeonTokenStore({ sql });
    const keyWithoutConnectionId: TokenKey = {
      provider: "zoho",
      accountId: "account-1",
    };

    await store.put(keyWithoutConnectionId, token);

    const insert = findCall(sql.calls, "INSERT INTO");
    expect(insert?.params?.[3]).toBeNull();
  });

  it("deletes by serialized token key", async () => {
    const sql = new FakeNeonSql();
    const store = new NeonTokenStore({ sql });

    await store.delete(key);

    const deleteCall = findCall(sql.calls, "DELETE FROM");
    expect(deleteCall?.params).toEqual([serializeTokenKey(key)]);
  });

  it("uses the same serialized token key for get, put, and delete", async () => {
    const sql = new FakeNeonSql();
    const store = new NeonTokenStore({ sql, ensureSchema: false });

    await store.get(key);
    await store.put(key, token);
    await store.delete(key);

    expect(findCall(sql.calls, "SELECT token_data")?.params?.[0]).toBe(
      serializeTokenKey(key),
    );
    expect(findCall(sql.calls, "INSERT INTO")?.params?.[0]).toBe(
      serializeTokenKey(key),
    );
    expect(findCall(sql.calls, "DELETE FROM")?.params?.[0]).toBe(
      serializeTokenKey(key),
    );
  });

  it("round-trips put then get then delete through a stateful SQL client", async () => {
    const sql = new StatefulNeonSql();
    const store = new NeonTokenStore({ sql });

    await store.put(key, token);
    await expect(store.get(key)).resolves.toEqual(token);
    await store.delete(key);
    await expect(store.get(key)).resolves.toBeNull();
  });

  it("updates an existing row on repeated put for the same TokenKey", async () => {
    const sql = new StatefulNeonSql();
    const store = new NeonTokenStore({ sql });
    const updatedToken: TokenRecord = {
      accessToken: "updated-access-token",
      refreshToken: "updated-refresh-token",
      expiresAt: 2_000,
    };

    await store.put(key, token);
    await store.put(key, updatedToken);

    await expect(store.get(key)).resolves.toEqual(updatedToken);
    expect(sql.size).toBe(1);
  });

  it("keeps rows isolated by provider, accountId, and connectionId", async () => {
    const sql = new StatefulNeonSql();
    const store = new NeonTokenStore({ sql });
    const firstKey = { ...key, connectionId: "connection-1" };
    const secondKey = { ...key, connectionId: "connection-2" };

    await store.put(firstKey, { ...token, accessToken: "first-access-token" });
    await store.put(secondKey, { ...token, accessToken: "second-access-token" });

    await expect(store.get(firstKey)).resolves.toMatchObject({
      accessToken: "first-access-token",
    });
    await expect(store.get(secondKey)).resolves.toMatchObject({
      accessToken: "second-access-token",
    });
  });

  it("supports Neon-style array results", async () => {
    const sql = new FakeNeonSql({
      selectResult: [{ token_data: JSON.stringify(token) }],
    });
    const store = new NeonTokenStore({ sql });

    await expect(store.get(key)).resolves.toEqual(token);
  });

  it("supports pg-style { rows } results", async () => {
    const sql = new FakeNeonSql({
      selectResult: { rows: [{ token_data: JSON.stringify(token) }] },
    });
    const store = new NeonTokenStore({ sql });

    await expect(store.get(key)).resolves.toEqual(token);
  });

  it("uses encryption when writing token_data", async () => {
    const encryption: TokenEncryption = {
      encrypt: vi.fn(async () => "ciphertext"),
      decrypt: vi.fn(async () => JSON.stringify(token)),
    };
    const sql = new FakeNeonSql();
    const store = new NeonTokenStore({ sql, encryption });

    await store.put(key, token);

    const insert = findCall(sql.calls, "INSERT INTO");
    expect(insert?.params?.[4]).toBe("ciphertext");
    expect(encryption.encrypt).toHaveBeenCalledWith({
      plaintext: JSON.stringify(token),
      context: {
        key,
        storeName: "neon",
      },
    });
  });

  it("stores encrypted token_data that is not parseable as plaintext JSON", async () => {
    const encryption: TokenEncryption = {
      encrypt: vi.fn(async () => "not-json-token-data"),
      decrypt: vi.fn(async () => JSON.stringify(token)),
    };
    const sql = new StatefulNeonSql();
    const store = new NeonTokenStore({ sql, encryption });

    await store.put(key, token);

    const storedTokenData = sql.getStoredTokenData(key);
    expect(storedTokenData).toBe("not-json-token-data");
    expect(() => JSON.parse(storedTokenData ?? "")).toThrow();
  });

  it("does not insert a token when encryption fails during put", async () => {
    const encryption: TokenEncryption = {
      encrypt: vi.fn(async () => {
        throw new Error("encrypt failed");
      }),
      decrypt: vi.fn(async () => JSON.stringify(token)),
    };
    const sql = new FakeNeonSql();
    const store = new NeonTokenStore({ sql, encryption });

    await expect(store.put(key, token)).rejects.toThrow("encrypt failed");
    expect(findCall(sql.calls, "INSERT INTO")).toBeUndefined();
  });

  it("uses encryption when reading token_data", async () => {
    const encryption: TokenEncryption = {
      encrypt: vi.fn(async () => "ciphertext"),
      decrypt: vi.fn(async () => JSON.stringify(token)),
    };
    const sql = new FakeNeonSql({
      selectResult: [{ token_data: "ciphertext" }],
    });
    const store = new NeonTokenStore({ sql, encryption });

    await expect(store.get(key)).resolves.toEqual(token);
    expect(encryption.decrypt).toHaveBeenCalledWith({
      ciphertext: "ciphertext",
      context: {
        key,
        storeName: "neon",
      },
    });
  });

  it("surfaces decryption failures during get", async () => {
    const encryption: TokenEncryption = {
      encrypt: vi.fn(async () => "ciphertext"),
      decrypt: vi.fn(async () => {
        throw new Error("decrypt failed");
      }),
    };
    const sql = new FakeNeonSql({
      selectResult: [{ token_data: "ciphertext" }],
    });
    const store = new NeonTokenStore({ sql, encryption });

    await expect(store.get(key)).rejects.toThrow("decrypt failed");
  });
});

class FakeNeonSql implements NeonSqlClient {
  readonly calls: QueryCall[] = [];
  private readonly selectResult: NeonQueryResult<TokenDataRow>;

  constructor(options: { selectResult?: NeonQueryResult<TokenDataRow> } = {}) {
    this.selectResult = options.selectResult ?? [];
  }

  async query<Row extends object = Record<string, unknown>>(
    query: string,
    params?: unknown[],
  ): Promise<NeonQueryResult<Row>> {
    this.calls.push({ query, params });

    if (query.includes("SELECT token_data")) {
      return this.selectResult as NeonQueryResult<Row>;
    }

    return [] as Row[];
  }
}

class FailOnceSchemaSql implements NeonSqlClient {
  readonly calls: QueryCall[] = [];
  private createTableAttempts = 0;

  async query<Row extends object = Record<string, unknown>>(
    query: string,
    params?: unknown[],
  ): Promise<NeonQueryResult<Row>> {
    this.calls.push({ query, params });

    if (query.includes("CREATE TABLE IF NOT EXISTS")) {
      this.createTableAttempts += 1;

      if (this.createTableAttempts === 1) {
        throw new Error("schema creation failed");
      }
    }

    return [] as Row[];
  }
}

class StatefulNeonSql implements NeonSqlClient {
  readonly calls: QueryCall[] = [];
  private readonly rows = new Map<string, TokenDataRow>();

  get size(): number {
    return this.rows.size;
  }

  getStoredTokenData(tokenKey: TokenKey): string | undefined {
    return this.rows.get(serializeTokenKey(tokenKey))?.token_data;
  }

  async query<Row extends object = Record<string, unknown>>(
    query: string,
    params?: unknown[],
  ): Promise<NeonQueryResult<Row>> {
    this.calls.push({ query, params });

    if (query.includes("SELECT token_data")) {
      const row = this.rows.get(String(params?.[0]));
      return (row ? [row] : []) as Row[];
    }

    if (query.includes("INSERT INTO")) {
      this.rows.set(String(params?.[0]), {
        token_data: String(params?.[4]),
      });
      return [] as Row[];
    }

    if (query.includes("DELETE FROM")) {
      this.rows.delete(String(params?.[0]));
      return [] as Row[];
    }

    return [] as Row[];
  }
}

function findCall(calls: QueryCall[], queryText: string): QueryCall | undefined {
  return calls.find((call) => call.query.includes(queryText));
}

function normalizeSql(query = ""): string {
  return query.replace(/\s+/g, " ").trim();
}
