import { constants, mkdtempSync, rmSync } from "node:fs";
import { open } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DuckDBInstance } from "@duckdb/node-api";
import { FusenError } from "./errors.ts";
import { bundledExtension } from "./extensions.ts";
import { ident, lit } from "./sql.ts";
import { ManyTables, showName } from "./source.ts";

/** The largest SQLite file that is copied to be read: the copy is made on every open. */
export const MAX_SQLITE_BYTES = 512 * 1024 * 1024;
/** How long the copy may take. */
export const SQLITE_COPY_TIMEOUT_MS = 60_000;
/** The most table names an error lists. */
const MAX_LISTED = 20;

export interface SqliteCopy {
  /** A DuckDB database file in a folder of its own, holding the one table. */
  path: string;
  /** The table, as the SQLite file spells it. */
  table: string;
  /** Deletes the copy. */
  remove(): void;
}

/**
 * Copies one table of a SQLite file into a DuckDB database file in a private folder, so that the engine that runs a
 * caller's query reads an ordinary DuckDB file and never has the SQLite extension loaded.
 *
 * Why a copy and not an ATTACH or `sqlite_scan` in the query engine: the extension opens the SQLite file with
 * SQLite's own file access, which `allowed_paths` and `enable_external_access` do not govern. With the extension
 * loaded, a query could read any other file that is a SQLite database (`sqlite_scan('/other.db', 't')`) and attach
 * one writable (`ATTACH 'x.db' (TYPE sqlite)`), after the configuration is locked. Here the extension is loaded in a
 * throwaway engine that runs only the statements below, none of which carries a caller's text (docs/adr/0004).
 * The SQLite file is opened read-only and is never written to.
 */
/**
 * Copies a regular file by reading it, without following a link (a sibling file) and without blocking on a pipe it
 * turned into since it was checked. A file that is not there is skipped unless `required`. Returns the bytes copied.
 */
async function copyFile(from: string, to: string, limit: number, required: boolean, signal?: AbortSignal): Promise<number> {
  const denied = new FusenError("cannot read this SQLite file");
  let source;
  try {
    source = await open(from, constants.O_RDONLY | constants.O_NONBLOCK | (required ? 0 : (constants.O_NOFOLLOW ?? 0)));
  } catch {
    if (required) throw denied;
    return 0;
  }
  try {
    const stat = await source.stat();
    if (!stat.isFile()) {
      if (required) throw denied;
      return 0;
    }
    if (stat.size > limit) {
      throw new FusenError(`this SQLite file is ${Math.ceil(stat.size / 1e6)} MB; fusenduck copies a table to read it and copies at most ${Math.floor(MAX_SQLITE_BYTES / 1e6)} MB`);
    }
    const target = await open(to, "wx", 0o600);
    try {
      const buffer = Buffer.allocUnsafe(1024 * 1024);
      let total = 0;
      for (;;) {
        if (signal?.aborted) throw new FusenError("the request was cancelled");
        const { bytesRead } = await source.read(buffer, 0, buffer.length, null);
        if (bytesRead === 0) break;
        total += bytesRead;
        if (total > limit) throw new FusenError(`this SQLite file is over ${Math.floor(MAX_SQLITE_BYTES / 1e6)} MB, the most fusenduck copies to read a table`);
        await target.write(buffer, 0, bytesRead);
      }
      return total;
    } finally {
      await target.close();
    }
  } finally {
    await source.close();
  }
}

export async function copySqlite(path: string, wanted: string | undefined, signal?: AbortSignal): Promise<SqliteCopy> {
  if (signal?.aborted) throw new FusenError("the request was cancelled");
  const dir = mkdtempSync(join(tmpdir(), "fusenduck-sqlite-"));
  const remove = () => rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
  const copy = join(dir, "sqlite.duckdb");
  let instance: DuckDBInstance | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    // SQLite writes beside a database it reads (a -shm and a -wal file for one in WAL mode), and a database that is being
    // written can change under a read. So the file, and the log of one in WAL mode, are copied to the private folder first.
    const used = await copyFile(path, join(dir, "src.sqlite"), MAX_SQLITE_BYTES, true, signal);
    await copyFile(`${path}-wal`, join(dir, "src.sqlite-wal"), MAX_SQLITE_BYTES - used, false, signal);
    instance = await DuckDBInstance.create(":memory:");
    const connection = await instance.connect();
    const stop = () => connection.interrupt();
    signal?.addEventListener("abort", stop, { once: true });
    timer = setTimeout(stop, SQLITE_COPY_TIMEOUT_MS);
    const probe = async (sql: string) => (await connection.runAndReadAll(sql)).getRowObjectsJson() as Record<string, unknown>[];
    try {
      // Nothing is installed or loaded by name: the one extension is the shipped file, checked against its pin.
      await connection.run("SET autoinstall_known_extensions=false");
      await connection.run("SET autoload_known_extensions=false");
      await connection.run("SET memory_limit='512MB'");
      await connection.run("SET threads=4");
      await connection.run("SET temp_directory=''");
      const engine = (await probe("SELECT version() AS v, platform AS p FROM pragma_platform()"))[0]!;
      await connection.run(`LOAD ${lit(bundledExtension("sqlite_scanner", String(engine.v), String(engine.p)))}`);
      await connection.run(`ATTACH ${lit(join(dir, "src.sqlite"))} AS src (TYPE sqlite, READ_ONLY)`);
      await connection.run(`ATTACH ${lit(copy)} AS dst`);
      const names = (await probe("SELECT table_name FROM information_schema.tables WHERE table_catalog = 'src' AND table_schema = 'main' ORDER BY table_name")).map((r) => String(r.table_name));
      let table: string;
      if (wanted === undefined) {
        if (names.length === 0) throw new FusenError("this SQLite file has no tables");
        if (names.length > 1) {
          const shown = names.slice(0, MAX_LISTED).map(showName).join(", ");
          throw new ManyTables(`this database has ${names.length} tables (${shown}${names.length > MAX_LISTED ? ", ..." : ""}): name one as file.sqlite#table`, names);
        }
        table = names[0]!;
      } else {
        // SQLite compares table names without regard to case, so does the lookup; the Ref keeps the file's spelling.
        const found = names.find((n) => n === wanted) ?? names.find((n) => n.toLowerCase() === wanted.toLowerCase());
        if (found === undefined) throw new FusenError(`this database has no table named "${showName(wanted)}"`);
        table = found;
      }
      await connection.run(`CREATE TABLE dst.main.${ident(table)} AS SELECT * FROM src.main.${ident(table)}`);
      await connection.run("DETACH src");
      await connection.run("DETACH dst");
      return { path: copy, table, remove };
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", stop);
      connection.closeSync();
    }
  } catch (error) {
    instance?.closeSync();
    instance = undefined;
    remove();
    if (error instanceof FusenError) throw error;
    if (signal?.aborted) throw new FusenError("the request was cancelled");
    // The engine's message can quote the file's contents or its path; this is the fixed wording (FUSEN_DEBUG=1 logs the cause).
    const message = String(error instanceof Error ? error.message : error);
    if (/interrupt/i.test(message)) throw new FusenError(`copying the SQLite table took more than ${SQLITE_COPY_TIMEOUT_MS / 1000} s`);
    if (/memory/i.test(message)) throw new FusenError("the SQLite table is too large to copy within the engine's memory limit");
    if (/not a database|malformed|encrypted/i.test(message)) throw new FusenError("this file is not a readable SQLite database");
    throw error;
  } finally {
    instance?.closeSync();
  }
}
