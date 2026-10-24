import { closeSync, constants, lstatSync, openSync, readdirSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { FusenError } from "./errors.ts";
import { ident, lit } from "./sql.ts";
import { createAdapter, isPattern, kindOf, type SourceAdapter, type SourceOptions } from "./source.ts";
import { DuckDBInstance, type DuckDBConnection } from "@duckdb/node-api";

export { ident, lit };

export type Row = Record<string, unknown>;

export interface Engine {
  /** The absolute path of the file this engine may read, or the pattern (`/data/*.csv`) that names several. */
  readonly source: string;
  /** The files behind `source`, real paths, sorted. One unless `source` is a pattern. */
  readonly files: string[];
  /** Whether `source` is a pattern. Then `data` has a `filename` column and positions are within each file. */
  readonly multi: boolean;
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
  if (roots && !realRoots(roots).some((root) => inside(root, path))) throw denied;
  return path;
}

const realRoots = (roots: string[]): string[] =>
  roots.flatMap((root) => {
    try {
      return [realpathSync(root)];
    } catch {
      return [];
    }
  });

/** The most files one pattern may name: the fingerprint and the allow list grow with them. */
export const MAX_FILES = 256;

/**
 * The files a pattern names, in name order. A wildcard (`*` for any run, `?` for one character) is allowed in the
 * file name only: the directory is literal, and nothing below it is searched. Each match is checked like a single
 * file (real path, regular file, inside the roots); a match that is not, such as a link out of the roots, is
 * left out, so the pattern cannot be used to reach it. Files starting with a dot match only a pattern that does.
 */
function resolvePattern(source: string, roots: string[] | undefined): { source: string; files: string[] } {
  const denied = new FusenError(roots ? `the source is not readable or is outside the allowed roots: ${source}` : `cannot read ${source}`);
  const name = basename(source);
  if (/[*?]/.test(dirname(source))) throw new FusenError("a wildcard is allowed in the file name only, not in a directory");
  let directory: string;
  let names: string[];
  try {
    directory = realpathSync(resolve(dirname(source)));
    names = readdirSync(directory);
  } catch {
    throw denied;
  }
  const escaped = [...name].map((c) => (c === "*" ? "[^/\\\\]*" : c === "?" ? "[^/\\\\]" : c.replace(/[.+^${}()|[\]\\]/g, "\\$&"))).join("");
  const matches = new RegExp(`^${escaped}$`);
  const allowed = roots ? realRoots(roots) : undefined;
  const files: string[] = [];
  for (const entry of names.filter((n) => matches.test(n) && (name.startsWith(".") || !n.startsWith("."))).sort()) {
    try {
      const real = realpathSync(join(directory, entry));
      if (!statSync(real).isFile()) continue;
      if (allowed && !allowed.some((root) => inside(root, real))) continue;
      files.push(real);
    } catch {
      continue;
    }
    if (files.length > MAX_FILES) throw new FusenError(`the pattern names more than ${MAX_FILES} files`);
  }
  if (files.length === 0) throw new FusenError(`no file matches ${source}`);
  return { source: join(directory, name), files };
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
export async function openSource(source: string, opts: { roots?: string[]; signal?: AbortSignal; kind?: string; options?: SourceOptions } = {}): Promise<Engine> {
  const multi = isPattern(source);
  const resolved = multi ? resolvePattern(source, opts.roots) : (() => { const p = resolveWithin(source, opts.roots); return { source: p, files: [p] }; })();
  const path = resolved.files[0]!;
  const { signal } = opts;
  // Without a kind from a Ref, the file name says; settings the Ref carries are used as they are, never detected again.
  let adapter = createAdapter(opts.kind ?? kindOf(path), opts.options);
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
    await connection.run(`SET allowed_paths=[${adapter.allowedPaths(resolved.files).map(lit).join(", ")}]`);
    // Untrusted SQL can be big without reading many bytes; bound what the engine may hold.
    await connection.run(`SET memory_limit='${MEMORY_LIMIT}'`);
    await connection.run("SET threads=4");
    // DuckDB may always read and write its spill directory (default: .tmp under the working
    // directory), whatever the lock says. No spill directory means nothing outside the source is reachable.
    await connection.run("SET temp_directory=''");
    await connection.run("SET enable_external_access=false");
    // The name a query uses for the source. Created before the lock so the file is bound while it is allowed.
    const probe = async (sql: string): Promise<Row[]> => (await connection.runAndReadAll(sql)).getRowObjectsJson() as Row[];
    binding = (async () => {
      adapter = await adapter.resolve(path, probe);
      if (multi) {
        // Several files: every row has its filename, and a position within its file for selecting by position.
        await connection.run(`CREATE VIEW data_pos AS ${adapter.positionView(resolved.files)}`);
        await connection.run(`CREATE VIEW data AS SELECT * EXCLUDE (${adapter.rowPosition}) FROM data_pos`);
      } else await connection.run(`CREATE VIEW data AS SELECT * FROM ${adapter.read(resolved.files)}`);
    })();
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
    source: resolved.source,
    files: resolved.files,
    multi,
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
