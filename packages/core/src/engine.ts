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
  /** Releases the engine. A query after this fails. */
  close(): void;
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
  const denied = new FusenError(
    roots ? `the source is not readable or is outside the allowed roots: ${source}` : `cannot read ${source}: there is no such file, or it is not readable`,
  );
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
export async function openSource(source: string, opts: { roots?: string[]; signal?: AbortSignal } = {}): Promise<Engine> {
  const path = resolveWithin(source, opts.roots);
  const { signal } = opts;
  const cancelled = () => new FusenError("the request was cancelled");
  if (signal?.aborted) throw cancelled();
  const instance = await DuckDBInstance.create(":memory:");
  const connection: DuckDBConnection = await instance.connect();
  await connection.run(`SET allowed_paths=[${lit(path)}]`);
  // Untrusted SQL can be big without reading many bytes; bound what the engine may hold.
  await connection.run(`SET memory_limit='${MEMORY_LIMIT}'`);
  await connection.run("SET threads=4");
  // DuckDB may always read and write its spill directory (default: .tmp under the working
  // directory), whatever the lock says. No spill directory means nothing outside the source is reachable.
  await connection.run("SET temp_directory=''");
  await connection.run("SET enable_external_access=false");
  // The name a query uses for the source. Created before the lock so the file is bound while it is allowed.
  await connection.run(`CREATE VIEW data AS SELECT * FROM read_parquet(${lit(path)})`);
  await connection.run("SET lock_configuration=true");
  if (signal?.aborted) {
    connection.closeSync();
    instance.closeSync();
    throw cancelled();
  }
  return {
    source: path,
    async query(sql: string, opts: { timeoutMs?: number } = {}): Promise<Row[]> {
      // A predicate is untrusted SQL and can be slow without reading many bytes; stop it on a clock.
      if (signal?.aborted) throw cancelled();
      const timer = opts.timeoutMs ? setTimeout(() => connection.interrupt(), opts.timeoutMs) : undefined;
      // A caller that goes away (a closed connection, a cancelled tool call) stops the running query.
      // An interrupt that lands before DuckDB has started the query is dropped, so it repeats until the query ends.
      let repeat: ReturnType<typeof setInterval> | undefined;
      const stop = () => {
        connection.interrupt();
        repeat = setInterval(() => connection.interrupt(), 25);
      };
      signal?.addEventListener("abort", stop, { once: true });
      try {
        const reader = await connection.runAndReadAll(sql);
        return reader.getRowObjectsJson() as Row[];
      } catch (error) {
        if (signal?.aborted) throw cancelled();
        if (timer && /interrupt/i.test(String(error))) throw new FusenError(`query stopped after ${opts.timeoutMs} ms`);
        throw error;
      } finally {
        clearTimeout(timer);
        clearInterval(repeat);
        signal?.removeEventListener("abort", stop);
      }
    },
    close(): void {
      connection.closeSync();
      instance.closeSync();
    },
  };
}
