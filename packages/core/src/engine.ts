import { closeSync, constants, lstatSync, openSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, relative } from "node:path";
import { FusenError } from "./errors.ts";
import { ident, lit } from "./sql.ts";
import { adapterFor, type SourceAdapter } from "./source.ts";
import { DuckDBInstance, type DuckDBConnection } from "@duckdb/node-api";

export { ident, lit };

export type Row = Record<string, unknown>;

export interface Engine {
  /** The absolute path of the one file this engine may read. */
  readonly source: string;
  /** How this kind of source is read, fingerprinted and addressed (docs/adr/0004). */
  readonly adapter: SourceAdapter;
  /** Runs one statement and returns its rows as JSON-safe objects (BIGINT and DECIMAL arrive as strings). */
  query(sql: string, opts?: { timeoutMs?: number; signal?: AbortSignal }): Promise<Row[]>;
  /** Releases the engine. A query after this fails. */
  close(): void;
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
 * Only a regular file is a source: opening a FIFO blocks inside DuckDB until something writes to
 * it, where neither the clock nor an interrupt can stop it.
 */
function resolveWithin(source: string, roots: string[] | undefined): string {
  const denied = new FusenError(
    roots ? `the source is not readable or is outside the allowed roots: ${source}` : `cannot read ${source}: there is no such file, or it is not readable`,
  );
  let path: string;
  try {
    path = realpathSync(source);
    if (!statSync(path).isFile()) throw denied;
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

/** How long the engine may take to bind its file. A local Parquet file binds in milliseconds. */
export const OPEN_TIMEOUT_MS = 10_000;

/**
 * Frees a reader that is blocked opening `path` because it turned into a FIFO after it was checked:
 * opening a FIFO for writing completes the reader's open (it then finds an empty pipe and fails).
 * DuckDB blocks inside the open system call, where neither the clock nor an interrupt reaches it.
 */
export function releasePipe(path: string): void {
  try {
    if (lstatSync(path).isFIFO()) closeSync(openSync(path, constants.O_WRONLY | constants.O_NONBLOCK));
  } catch {
    // Not a pipe, or no reader is waiting.
  }
}

/** Runs the engine's first read of `path`; past `timeoutMs` the open is released and the caller gets an answer. */
export async function watchOpen<T>(path: string, work: Promise<T>, timeoutMs = OPEN_TIMEOUT_MS): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      releasePipe(path);
      reject(new FusenError(`the source did not open within ${timeoutMs} ms: ${path}`));
    }, timeoutMs);
  });
  try {
    return await Promise.race([work, late]);
  } finally {
    clearTimeout(timer);
    work.catch(() => undefined);
  }
}

/**
 * Opens one file read-only by construction. The engine is locked down before it is returned:
 * only this exact path is readable, nothing can be written (COPY TO, ATTACH, overwriting the
 * source), and the configuration cannot be changed afterwards. See docs/adr/0001.
 */
export async function openSource(source: string, opts: { roots?: string[]; signal?: AbortSignal } = {}): Promise<Engine> {
  const path = resolveWithin(source, opts.roots);
  const { signal } = opts;
  const adapter = adapterFor(path);
  const cancelled = () => new FusenError("the request was cancelled");
  if (signal?.aborted) throw cancelled();
  const instance = await DuckDBInstance.create(":memory:");
  const connection: DuckDBConnection = await instance.connect();
  // The engine is released when opening fails, once a read of the file that is still running has ended.
  let binding: Promise<unknown> | undefined;
  const release = () => {
    connection.closeSync();
    instance.closeSync();
  };
  try {
    await connection.run(`SET allowed_paths=[${lit(path)}]`);
    // Untrusted SQL can be big without reading many bytes; bound what the engine may hold.
    await connection.run(`SET memory_limit='${MEMORY_LIMIT}'`);
    await connection.run("SET threads=4");
    // DuckDB may always read and write its spill directory (default: .tmp under the working
    // directory), whatever the lock says. No spill directory means nothing outside the source is reachable.
    await connection.run("SET temp_directory=''");
    await connection.run("SET enable_external_access=false");
    // The name a query uses for the source. Created before the lock so the file is bound while it is allowed.
    binding = connection.run(`CREATE VIEW data AS SELECT * FROM ${adapter.read(path)}`);
    await watchOpen(path, binding);
    await connection.run("SET lock_configuration=true");
  } catch (error) {
    void Promise.resolve(binding).then(release, release);
    throw error;
  }
  if (signal?.aborted) {
    release();
    throw cancelled();
  }
  return {
    source: path,
    adapter,
    async query(sql: string, opts: { timeoutMs?: number; signal?: AbortSignal } = {}): Promise<Row[]> {
      // The caller of one query (a request of the Web UI) may go away while the engine lives on.
      const signals = [signal, opts.signal].filter((s): s is AbortSignal => s !== undefined);
      const gone = () => signals.some((s) => s.aborted);
      // A predicate is untrusted SQL and can be slow without reading many bytes; stop it on a clock.
      if (gone()) throw cancelled();
      // The file is read again by every query, so it may have turned into a FIFO since it was opened;
      // an interrupt does not reach a blocked open, so the pipe is released as well.
      const interrupt = () => {
        connection.interrupt();
        releasePipe(path);
      };
      let timedOut = false;
      // An interrupt that lands before DuckDB has started the query is dropped, and a pipe released
      // before the open began frees nothing, so both repeat until the query ends.
      let repeat: ReturnType<typeof setInterval> | undefined;
      const stop = () => {
        interrupt();
        repeat ??= setInterval(interrupt, 25);
      };
      const timer = opts.timeoutMs
        ? setTimeout(() => {
            timedOut = true;
            stop();
          }, opts.timeoutMs)
        : undefined;
      // A caller that goes away (a closed connection, a cancelled tool call) stops the running query.
      for (const s of signals) s.addEventListener("abort", stop, { once: true });
      try {
        const reader = await connection.runAndReadAll(sql);
        return reader.getRowObjectsJson() as Row[];
      } catch (error) {
        if (gone()) throw cancelled();
        // A released pipe fails the read with another message than an interrupt does.
        if (timedOut || (timer && /interrupt/i.test(String(error)))) throw new FusenError(`query stopped after ${opts.timeoutMs} ms`);
        throw error;
      } finally {
        clearTimeout(timer);
        clearInterval(repeat);
        for (const s of signals) s.removeEventListener("abort", stop);
      }
    },
    close(): void {
      connection.closeSync();
      instance.closeSync();
    },
  };
}
