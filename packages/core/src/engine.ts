import { realpathSync } from "node:fs";
import { isAbsolute, relative } from "node:path";
import { FusenError } from "./errors.ts";
import { DuckDBInstance, type DuckDBConnection } from "@duckdb/node-api";

export type Row = Record<string, unknown>;

export interface Engine {
  /** The absolute path of the one file this engine may read. */
  readonly source: string;
  /** Runs one statement and returns its rows as JSON-safe objects (BIGINT and DECIMAL arrive as strings). */
  query(sql: string, opts?: { timeoutMs?: number }): Promise<Row[]>;
}

/** A SQL string literal. */
export function lit(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

/** A SQL identifier. */
export function ident(name: string): string {
  return `"${name.replaceAll('"', '""')}"`;
}

const MEMORY_LIMIT = "512MB";

const inside = (root: string, path: string): boolean => {
  const rel = relative(root, path);
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
};

/**
 * The real path of `source`, checked against the roots once. The engine is opened on this same
 * path, so a symlink swapped after the check cannot redirect it. A missing file and a file
 * outside the roots give one message, so the error does not tell a caller what exists elsewhere.
 */
function resolveWithin(source: string, roots: string[] | undefined): string {
  const denied = new FusenError(`the source is not readable or is outside the allowed roots: ${source}`);
  let path: string;
  try {
    path = realpathSync(source);
  } catch {
    throw denied;
  }
  if (roots) {
    const real = roots.flatMap((root) => {
      try {
        return [realpathSync(root)];
      } catch {
        return [];
      }
    });
    if (!real.some((root) => inside(root, path))) throw denied;
  }
  return path;
}

/**
 * Opens one file read-only by construction. The engine is locked down before it is returned:
 * only this exact path is readable, nothing can be written (COPY TO, ATTACH, overwriting the
 * source), and the configuration cannot be changed afterwards. See docs/adr/0001.
 */
export async function openSource(source: string, opts: { roots?: string[] } = {}): Promise<Engine> {
  const path = resolveWithin(source, opts.roots);
  const instance = await DuckDBInstance.create(":memory:");
  const connection: DuckDBConnection = await instance.connect();
  await connection.run(`SET allowed_paths=[${lit(path)}]`);
  // Untrusted SQL can be big without reading many bytes; bound what the engine may hold.
  await connection.run(`SET memory_limit='${MEMORY_LIMIT}'`);
  await connection.run("SET threads=4");
  await connection.run("SET enable_external_access=false");
  // The name a query uses for the source. Created before the lock so the file is bound while it is allowed.
  await connection.run(`CREATE VIEW data AS SELECT * FROM read_parquet(${lit(path)})`);
  await connection.run("SET lock_configuration=true");
  return {
    source: path,
    async query(sql: string, opts: { timeoutMs?: number } = {}): Promise<Row[]> {
      // A predicate is untrusted SQL and can be slow without reading many bytes; stop it on a clock.
      const timer = opts.timeoutMs ? setTimeout(() => connection.interrupt(), opts.timeoutMs) : undefined;
      try {
        const reader = await connection.runAndReadAll(sql);
        return reader.getRowObjectsJson() as Row[];
      } catch (error) {
        if (timer && /interrupt/i.test(String(error))) throw new FusenError(`query stopped after ${opts.timeoutMs} ms`);
        throw error;
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
