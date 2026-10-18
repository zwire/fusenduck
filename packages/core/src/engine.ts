import { realpathSync } from "node:fs";
import { DuckDBInstance, type DuckDBConnection } from "@duckdb/node-api";

export type Row = Record<string, unknown>;

export interface Engine {
  /** The absolute path of the one file this engine may read. */
  readonly source: string;
  /** Runs one statement and returns its rows as JSON-safe objects (BIGINT and DECIMAL arrive as strings). */
  query(sql: string): Promise<Row[]>;
}

/** A SQL string literal. */
export function lit(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

/** A SQL identifier. */
export function ident(name: string): string {
  return `"${name.replaceAll('"', '""')}"`;
}

/**
 * Opens one file read-only by construction. The engine is locked down before it is returned:
 * only this exact path is readable, nothing can be written (COPY TO, ATTACH, overwriting the
 * source), and the configuration cannot be changed afterwards. See docs/adr/0001.
 */
export async function openSource(source: string): Promise<Engine> {
  const path = realpathSync(source);
  const instance = await DuckDBInstance.create(":memory:");
  const connection: DuckDBConnection = await instance.connect();
  await connection.run(`SET allowed_paths=[${lit(path)}]`);
  await connection.run("SET enable_external_access=false");
  await connection.run("SET lock_configuration=true");
  return {
    source: path,
    async query(sql: string): Promise<Row[]> {
      const reader = await connection.runAndReadAll(sql);
      return reader.getRowObjectsJson() as Row[];
    },
  };
}
