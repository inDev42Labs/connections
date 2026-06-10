import type { TokenEncryption } from "../../core";

export type NeonQueryResult<Row extends object = Record<string, unknown>> =
  | Row[]
  | { rows: Row[] };

export type NeonSqlClient = {
  query<Row extends object = Record<string, unknown>>(
    query: string,
    params?: unknown[],
  ): Promise<NeonQueryResult<Row>>;
};

export type NeonTokenStoreOptions = {
  sql: NeonSqlClient;
  schemaName?: string;
  tableName?: string;
  encryption?: TokenEncryption;
  ensureSchema?: boolean;
};
