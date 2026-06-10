import {
  deserializeTokenRecordFromStorage,
  serializeTokenKey,
  serializeTokenRecordForStorage,
  TokenStoreError,
  type TokenKey,
  type TokenRecord,
  type TokenStore,
} from "../../core";
import type {
  NeonQueryResult,
  NeonSqlClient,
  NeonTokenStoreOptions,
} from "./neon.types";

type TokenDataRow = {
  token_data: string;
};

export class NeonTokenStore implements TokenStore {
  readonly storeName = "neon";
  readonly tableName: string;
  readonly schemaName?: string;

  private readonly sql: NeonSqlClient;
  private readonly tableIdentifier: string;
  private readonly options: Omit<NeonTokenStoreOptions, "sql">;
  private ensureSchemaPromise?: Promise<void>;

  constructor(options: NeonTokenStoreOptions) {
    if (!options.sql) {
      throw new TokenStoreError("NeonTokenStore requires a sql client");
    }

    this.sql = options.sql;
    this.tableName = options.tableName ?? "oauth_tokens";
    this.schemaName = options.schemaName;
    this.tableIdentifier = createQualifiedIdentifier({
      schemaName: this.schemaName,
      tableName: this.tableName,
    });
    this.options = {
      encryption: options.encryption,
      ensureSchema: options.ensureSchema,
      schemaName: options.schemaName,
      tableName: options.tableName,
    };
  }

  async ensureSchema(): Promise<void> {
    this.ensureSchemaPromise ??= this.createSchema().catch((error: unknown) => {
      this.ensureSchemaPromise = undefined;
      throw error;
    });

    return this.ensureSchemaPromise;
  }

  async get(key: TokenKey): Promise<TokenRecord | null> {
    await this.ensureReady();

    const rows = await this.query<TokenDataRow>(
      `SELECT token_data FROM ${this.tableIdentifier} WHERE token_key = $1 LIMIT 1`,
      [serializeTokenKey(key)],
    );
    const row = rows[0];

    if (!row) {
      return null;
    }

    return deserializeTokenRecordFromStorage({
      value: row.token_data,
      key,
      encryption: this.options.encryption,
      storeName: this.storeName,
    });
  }

  async put(key: TokenKey, token: TokenRecord): Promise<void> {
    await this.ensureReady();

    const tokenData = await serializeTokenRecordForStorage({
      token,
      key,
      encryption: this.options.encryption,
      storeName: this.storeName,
    });

    await this.query(
      `INSERT INTO ${this.tableIdentifier} (
        token_key,
        provider,
        account_id,
        connection_id,
        token_data
      ) VALUES ($1, $2, $3, $4, $5)
      ON CONFLICT (token_key)
      DO UPDATE SET
        provider = EXCLUDED.provider,
        account_id = EXCLUDED.account_id,
        connection_id = EXCLUDED.connection_id,
        token_data = EXCLUDED.token_data,
        updated_at = now()`,
      [
        serializeTokenKey(key),
        key.provider,
        key.accountId,
        key.connectionId ?? null,
        tokenData,
      ],
    );
  }

  async delete(key: TokenKey): Promise<void> {
    await this.ensureReady();

    await this.query(`DELETE FROM ${this.tableIdentifier} WHERE token_key = $1`, [
      serializeTokenKey(key),
    ]);
  }

  private async ensureReady(): Promise<void> {
    if (this.options.ensureSchema === false) {
      return;
    }

    await this.ensureSchema();
  }

  private async createSchema(): Promise<void> {
    if (this.schemaName) {
      await this.query(`CREATE SCHEMA IF NOT EXISTS ${quoteIdentifier(this.schemaName)}`);
    }

    await this.query(`CREATE TABLE IF NOT EXISTS ${this.tableIdentifier} (
      token_key text PRIMARY KEY,
      provider text NOT NULL,
      account_id text NOT NULL,
      connection_id text,
      token_data text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    )`);
  }

  private async query<Row extends object = Record<string, unknown>>(
    query: string,
    params?: unknown[],
  ): Promise<Row[]> {
    const result = await this.sql.query<Row>(query, params);
    return getRows(result);
  }
}

function getRows<Row extends object>(result: NeonQueryResult<Row>): Row[] {
  return Array.isArray(result) ? result : result.rows;
}

function createQualifiedIdentifier(input: {
  schemaName?: string;
  tableName: string;
}): string {
  const tableName = quoteIdentifier(input.tableName);

  if (!input.schemaName) {
    return tableName;
  }

  return `${quoteIdentifier(input.schemaName)}.${tableName}`;
}

function quoteIdentifier(identifier: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(identifier)) {
    throw new TokenStoreError(
      `Invalid Postgres identifier '${identifier}'. Use schemaName/tableName values containing only letters, numbers, and underscores, starting with a letter or underscore.`,
    );
  }

  return `"${identifier}"`;
}
