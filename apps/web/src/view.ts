import { statSync } from "node:fs";
import { resolve } from "node:path";
import {
  buildCard,
  checkPredicate,
  DEFAULT_TIMEOUT_MS,
  fingerprint,
  FusenError,
  ManyTables,
  mintRefWith,
  openSource,
  SourceChanged,
  ident,
  lit,
  type DataCard,
  type Engine,
} from "@fusenduck/core";

// One open file, as the UI sees it: one engine per source (docs/adr/0001), closed when another
// file is opened or the server stops. Everything the browser sends is a number; the SQL is built here.

export const DEFAULT_PAGE_ROWS = 100;
export const MAX_PAGE_ROWS = 500;
/** Ranges one selection may merge into; past this, a selection is refused. */
export const MAX_RANGES = 1000;
/** A cell longer than this is cut for display (the cut is marked). */
export const MAX_CELL_CHARS = 200;
/** A page stops adding rows past this many characters of cells; the response says where to go on. */
export const MAX_PAGE_CHARS = 2 * 1024 * 1024;
/** Longest filter accepted; a filter is typed by hand. */
export const MAX_FILTER_CHARS = 4096;

export interface Opened {
  source: string;
  fingerprint: string;
  card: DataCard;
  /** The Ref for the whole file, shown when nothing is selected. */
  ref: string;
  /**
   * False when rows cannot be selected by position: a database table (a row's place moves when rows are deleted,
   * so it is selected by a column), or a file with its own column named file_row_number.
   */
  selectable: boolean;
  /** The kind of source: parquet, csv, ndjson, json, duckdb or sqlite. */
  kind: string;
  /** The files behind the source: more than one when it was opened as a pattern. */
  files: number;
  /** The table of a DuckDB database file. */
  table?: string;
}

export interface Page {
  /** Each row's position in the file (from 0; for several files, in the files taken in name order), or null when positions cannot be selected. */
  rows: { pos: number | null; cells: (string | null)[] }[];
  /** The offset of the next page, or null at the end of the file. */
  next: number | null;
  /** True when rows were left for the next page because this one reached MAX_PAGE_CHARS. */
  cut: boolean;
  /** Rows of the file that pass the filter (every row when there is none). */
  matched: number;
}

export type Range = [number, number];

const CHANGED = "the file changed since it was opened. Open it again.";

/**
 * An error about the person's filter, in words that point at the fix. The filter runs inside
 * `WHERE (…)`, so a condition that stops short fails at the closing parenthesis it never typed.
 */
function rejected(message: string, text: string, columns: string[]): FusenError {
  const said = message.replace(/^predicate rejected: /, "").replace(/^(Parser|Binder|Catalog) Error: /, "");
  const missing = /^Referenced column "(.*)" not found in FROM clause/.exec(said);
  if (missing) {
    const list = columns.slice(0, 20).join(", ") + (columns.length > 20 ? `, … (${columns.length} in all)` : "");
    return new FusenError(`filter rejected: this file has no column named "${missing[1]}". Its columns are ${list}`);
  }
  if (said === 'syntax error at or near ")"' && !text.includes(")")) {
    return new FusenError("filter rejected: the condition is not finished, e.g. amount > 100");
  }
  return new FusenError(`filter rejected: ${said.slice(0, 300)}`);
}

/** Sorted, merged ranges of positions, checked against the row count. */
export function mergeRanges(ranges: unknown, rows: number): Range[] {
  if (!Array.isArray(ranges) || ranges.length === 0) throw new FusenError("select at least one row");
  const checked = ranges.map((r): Range => {
    if (!Array.isArray(r) || r.length !== 2 || !r.every((n) => Number.isSafeInteger(n))) {
      throw new FusenError("a range is two row positions");
    }
    const [a, b] = r as Range;
    if (a < 0 || b < a || b >= rows) throw new FusenError(`a range must lie within positions 0 to ${rows - 1}`);
    return [a, b];
  });
  checked.sort((x, y) => x[0] - y[0]);
  const merged: Range[] = [];
  for (const [a, b] of checked) {
    const last = merged.at(-1);
    if (last && a <= last[1] + 1) last[1] = Math.max(last[1], b);
    else merged.push([a, b]);
  }
  if (merged.length > MAX_RANGES) throw new FusenError(`a selection may hold at most ${MAX_RANGES} separate ranges`);
  return merged;
}

/** The predicate a selection of positions stands for. */
export function rangesPredicate(ranges: Range[]): string {
  return ranges
    .map(([a, b]) => (a === b ? `file_row_number = ${a}` : `file_row_number BETWEEN ${a} AND ${b}`))
    .join(" OR ");
}

/** The files of a pattern in name order, each with how many rows it has: the positions of the whole run through them. */
export type Layout = { file: string; rows: number }[];

/**
 * The predicate the positions of a pattern's rows stand for: each range, cut where it crosses from one file into
 * the next, becomes `filename = … AND file_row_number BETWEEN …` (the position within that file, as a Ref selects it).
 */
export function layoutPredicate(ranges: Range[], layout: Layout): string {
  const parts: string[] = [];
  let start = 0;
  for (const { file, rows } of layout) {
    for (const [a, b] of ranges) {
      const from = Math.max(a, start);
      const to = Math.min(b, start + rows - 1);
      if (from > to) continue;
      const inside = from === to ? `file_row_number = ${from - start}` : `file_row_number BETWEEN ${from - start} AND ${to - start}`;
      parts.push(`(filename = ${lit(file)} AND ${inside})`);
    }
    start += rows;
  }
  return parts.join(" OR ");
}

/** The most table names offered for one database file. */
export const MAX_TABLES = 500;

/**
 * The tables of a DuckDB or SQLite file in the main schema, for the person to choose from. The file is opened read-only
 * like any source; a file with one table opens as it is.
 */
export async function tablesOf(path: string, roots: string[], signal?: AbortSignal): Promise<string[]> {
  if (typeof path !== "string" || !/\.(duckdb|ddb|sqlite|sqlite3|db3)$/i.test(path)) throw new FusenError("give the path of a DuckDB or SQLite file");
  try {
    const engine = await openSource(resolve(roots[0] ?? process.cwd(), path), { roots, ...(signal ? { signal } : {}) });
    try {
      return [engine.adapter.options.table!];
    } finally {
      engine.close();
    }
  } catch (error) {
    if (error instanceof ManyTables) return error.tables.slice(0, MAX_TABLES);
    throw error;
  }
}

/**
 * The size, modified time and identity of the files of a text source. Its fingerprint hashes every byte, which a
 * page cannot afford each time, so a page asks the files whether they were touched at all; a Ref still checks the
 * bytes when it is minted. Other kinds read a footer or metadata, which is cheap, and give undefined. A rewrite
 * that keeps all three (a restored modified time) is not noticed by a page.
 */
function signature(kind: string, files: string[]): string | undefined {
  if (kind === "parquet" || kind === "duckdb") return undefined;
  try {
    return JSON.stringify(files.map((f) => {
      const s = statSync(f);
      return [s.size, s.mtimeMs, s.ino];
    }));
  } catch {
    return undefined;
  }
}

export class View {
  #tail: Promise<unknown> = Promise.resolve();
  #closed = false;
  #closing: Promise<void> | undefined;
  /** What #touched said when the bytes were last found to match the fingerprint. */
  #verified: string | undefined;
  /** The count of the last filter, so paging through its rows counts them once. */
  #counted: { where: string; n: number } | undefined;

  /** The caller of the operation that is running, whose going away stops its queries. */
  #signal: AbortSignal | undefined;
  readonly opened: Opened;
  readonly #engine: Engine;
  readonly #columns: string[];
  /** The table the page reads: with a position column when rows can be selected by position. */
  readonly #from: string;
  /** The column of that table that holds a row's position. */
  readonly #pos: string;
  /** For a pattern, how the files follow each other. */
  readonly #layout: Layout | undefined;

  private constructor(engine: Engine, opened: Opened, columns: string[], from: string, pos: string, layout?: Layout) {
    // Every query of an operation carries its caller's signal, however deep it is issued (fingerprint,
    // checkPredicate and mintRefWith run their own).
    this.#engine = {
      source: engine.source,
      files: engine.files,
      multi: engine.multi,
      adapter: engine.adapter,
      query: (sql, options) => engine.query(sql, { ...options, ...(this.#signal ? { signal: this.#signal } : {}) }),
      close: () => engine.close(),
    };
    this.opened = opened;
    this.#columns = columns;
    this.#from = from;
    this.#pos = pos;
    this.#layout = layout;
  }

  /**
   * Opens `path` (relative paths start at the first root) under `roots`: a Parquet, CSV, NDJSON or JSON file, a
   * pattern with a wildcard in the file name, or a table of a DuckDB or SQLite file (`file.duckdb#table`).
   */
  static async open(path: string, roots: string[]): Promise<View> {
    if (typeof path !== "string" || path.trim() === "") throw new FusenError("give the path of a file");
    const engine = await openSource(resolve(roots[0] ?? process.cwd(), path), { roots });
    try {
      const described = await engine.query("DESCRIBE SELECT * FROM data");
      const columns = described.map((c) => String(c.column_name));
      const database = engine.adapter.database;
      // A real column of that name shadows the position in a predicate (docs/adr/0001), and DuckDB
      // compares identifiers without case. A database table has no position to select by.
      const selectable = !database && !columns.some((c) => c.toLowerCase() === "file_row_number");
      // Looked at before the bytes are hashed, so a rewrite in between is not taken for the hashed bytes.
      const before = signature(engine.adapter.name, engine.files);
      const fp = await fingerprint(engine);
      const card = await buildCard(engine);
      const ref = await mintRefWith(engine, { expect: fp });
      let from = "data";
      let pos = "file_row_number";
      let layout: Layout | undefined;
      if (engine.multi) {
        // The files' own column of that name would be replaced by the position that Refs select by.
        const own = await engine.query(`DESCRIBE SELECT * FROM ${engine.adapter.read(engine.files, true)}`);
        if (own.some((c) => String(c.column_name).toLowerCase() === "file_row_number")) {
          throw new FusenError("the files have a column named file_row_number, which a pattern cannot keep: open them one at a time");
        }
      }
      if (selectable && engine.multi) {
        // Positions run through the files in name order; the engine reads them in parallel, so each file's rows are counted.
        const counts = new Map(
          (await engine.query("SELECT filename, count(*)::VARCHAR AS n FROM data GROUP BY filename")).map((r) => [String(r.filename), Number(r.n)]),
        );
        layout = engine.files.flatMap((file) => (counts.get(file) ? [{ file, rows: counts.get(file)! }] : []));
        if (layout.reduce((sum, f) => sum + f.rows, 0) !== card.rows) throw new FusenError("the files could not be told apart by name: open them one at a time");
        let start = 0;
        const offsets = layout.map(({ file, rows }) => {
          const when = `WHEN ${lit(file)} THEN ${start}`;
          start += rows;
          return when;
        });
        pos = "fusen_position";
        from = `(SELECT *, CASE filename ${offsets.join(" ")} END + file_row_number AS ${pos} FROM data_pos)`;
      } else if (selectable) {
        from = `(${engine.adapter.baseQuery(engine.files[0]!, true)})`;
      }
      const table = engine.adapter.options.table;
      const opened: Opened = {
        source: engine.source,
        fingerprint: fp,
        card,
        ref,
        selectable,
        kind: engine.adapter.name,
        files: engine.files.length,
        ...(table === undefined ? {} : { table }),
      };
      const view = new View(engine, opened, columns, from, pos, layout);
      view.#verified = before;
      return view;
    } catch (error) {
      engine.close();
      throw error;
    }
  }

  /** Runs one operation at a time on the engine, which has one connection. */
  #serial<T>(work: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    const run = this.#tail.then(async () => {
      if (this.#closed) throw new FusenError("this file was closed. Open it again.");
      // A caller that left while it waited its turn does not take one.
      if (signal?.aborted) throw new FusenError("the request was cancelled");
      this.#signal = signal;
      try {
        return await work();
      } finally {
        this.#signal = undefined;
      }
    });
    this.#tail = run.catch(() => undefined);
    return run;
  }

  #touched(): string | undefined {
    return signature(this.opened.kind, this.#engine.files);
  }

  async #check(expected: unknown): Promise<void> {
    if (expected !== this.opened.fingerprint) throw new SourceChanged(CHANGED);
    const touched = this.#touched();
    if (touched !== undefined && touched === this.#verified) return;
    if ((await fingerprint(this.#engine)) !== this.opened.fingerprint) throw new SourceChanged(CHANGED);
    this.#verified = touched;
  }

  /**
   * The filter the page sent, checked before it runs: undefined when there is none. A filter is a
   * condition on the file's own columns: it may not read a table (a table function such as read_csv
   * would read the file's bytes while binding) or use * or COLUMNS(*), whose columns differ between
   * the page and a Ref that names file_row_number. The text is the person's own, so a parser, binder
   * or catalog error about it (a misspelled column, a wrong type) is shown; those come before any
   * row is read. Any other error is withheld.
   */
  async #filter(where: unknown): Promise<string | undefined> {
    if (where === undefined || where === null) return undefined;
    if (typeof where !== "string") throw new FusenError("the filter must be text");
    const text = where.trim();
    if (text === "") return undefined;
    if (text.length > MAX_FILTER_CHARS) throw new FusenError(`a filter may be at most ${MAX_FILTER_CHARS} characters`);
    await checkPredicate(this.#engine, this.#engine.source, text).catch((error: unknown) => {
      throw error instanceof FusenError && error.message.startsWith("predicate rejected: ") ? rejected(error.message, text, this.#columns) : error;
    });
    const parsed = String((await this.#engine.query(`SELECT json_serialize_sql(${lit(`SELECT 1 WHERE (\n${text}\n)`)}) AS j`))[0]?.j);
    if (parsed.includes('"TABLE_FUNCTION"')) throw new FusenError("filter rejected: a filter may not read a table; use the file's columns");
    if (parsed.includes('"STAR"')) throw new FusenError("filter rejected: name the columns instead of * or COLUMNS(*)");
    try {
      await this.#engine.query(`DESCRIBE SELECT 1 FROM ${this.#from} WHERE (\n${text}\n)`, {
        timeoutMs: DEFAULT_TIMEOUT_MS,
      });
    } catch (error) {
      const message = (error instanceof Error ? error.message : String(error)).split("\n")[0]!;
      if (!/^(Parser|Binder|Catalog) Error:/.test(message)) throw error;
      throw rejected(message, text, this.#columns);
    }
    return text;
  }

  /** The columns the page keeps, in the file's order: undefined when it keeps them all. */
  #keep(columns: unknown): string[] | undefined {
    if (columns === undefined || columns === null) return undefined;
    if (!Array.isArray(columns) || !columns.every((c) => typeof c === "string")) {
      throw new FusenError("columns must be a list of column names");
    }
    const wanted = new Set(columns);
    const unknown = [...wanted].find((c) => !this.#columns.includes(c));
    if (unknown !== undefined) throw new FusenError(`this file has no column named ${JSON.stringify(unknown)}`);
    if (wanted.size === 0) throw new FusenError("keep at least one column");
    return wanted.size === this.#columns.length ? undefined : this.#columns.filter((c) => wanted.has(c));
  }

  rows(expected: unknown, offset: unknown, limit: unknown = DEFAULT_PAGE_ROWS, where?: unknown, signal?: AbortSignal): Promise<Page> {
    return this.#serial(async () => {
      await this.#check(expected);
      if (!Number.isSafeInteger(offset) || (offset as number) < 0) throw new FusenError("offset must be a non-negative integer");
      if (!Number.isSafeInteger(limit) || (limit as number) < 1 || (limit as number) > MAX_PAGE_ROWS) {
        throw new FusenError(`limit must be an integer from 1 to ${MAX_PAGE_ROWS}`);
      }
      const filter = await this.#filter(where);
      const from = offset as number;
      const n = limit as number;
      // Every cell arrives as text cut in the engine, so a huge cell is never read whole into the page.
      const cells = this.#columns.map((c, i) => `left(CAST(${ident(c)} AS VARCHAR), ${MAX_CELL_CHARS + 1}) AS c${i}`);
      const source = this.#from;
      const pos = this.#pos;
      // The filter sits alone on its lines, as in a Ref, so a "--" comment cannot swallow what follows.
      const matches = filter === undefined ? "" : `(\n${filter}\n)`;
      const matched = filter === undefined ? this.opened.card.rows : await this.#count(filter, `SELECT count(*)::VARCHAR AS n FROM ${source} WHERE ${matches}`);
      let sql: string;
      if (!this.opened.selectable) {
        sql = `SELECT ${cells.join(", ")} FROM ${source}${filter === undefined ? "" : ` WHERE ${matches}`} LIMIT ${n} OFFSET ${from}`;
      } else if (filter === undefined) {
        sql = `SELECT ${pos}::VARCHAR AS pos, ${cells.join(", ")} FROM ${source}
           WHERE ${pos} BETWEEN ${from} AND ${from + n - 1} ORDER BY ${pos}`;
      } else {
        // With a filter, the offset is the position to go on from; one row more says where the next page starts.
        sql = `SELECT ${pos}::VARCHAR AS pos, ${cells.join(", ")} FROM ${source}
           WHERE ${matches} AND ${pos} >= ${from} ORDER BY ${pos} LIMIT ${n + 1}`;
      }
      const scan = this.opened.selectable || from < matched;
      const found = scan ? await this.#engine.query(sql, { timeoutMs: DEFAULT_TIMEOUT_MS }) : [];
      const page: Page = { rows: [], next: null, cut: false, matched };
      let chars = 0;
      for (const row of found.slice(0, n)) {
        const values = this.#columns.map((_, i) => {
          const v = row[`c${i}`];
          if (v === null || v === undefined) return null;
          // The engine cut by code points; count them the same way, so a pair is never split.
          const chars = [...String(v)];
          return chars.length > MAX_CELL_CHARS ? `${chars.slice(0, MAX_CELL_CHARS).join("")}…` : chars.join("");
        });
        chars += values.reduce((sum, v) => sum + (v?.length ?? 0), 0);
        if (chars > MAX_PAGE_CHARS && page.rows.length > 0) {
          page.cut = true;
          break;
        }
        page.rows.push({ pos: this.opened.selectable ? Number(row.pos) : null, cells: values });
      }
      if (this.opened.selectable && filter !== undefined) {
        const after = found[page.rows.length];
        page.next = after ? Number(after.pos) : null;
      } else {
        const end = from + page.rows.length;
        page.next = end < (this.opened.selectable ? this.opened.card.rows : matched) ? end : null;
      }
      return page;
    }, signal);
  }

  async #count(where: string, sql: string): Promise<number> {
    if (this.#counted?.where !== where) {
      const n = Number((await this.#engine.query(sql, { timeoutMs: DEFAULT_TIMEOUT_MS }))[0]?.n ?? 0);
      this.#counted = { where, n };
    }
    return this.#counted.n;
  }

  /**
   * The Ref for what the page shows: the selected positions, the rows that pass the filter, or both
   * (a Shift range under a filter spans rows the table hides), and only the kept columns.
   */
  ref(expected: unknown, ranges: unknown, where?: unknown, columns?: unknown, signal?: AbortSignal): Promise<string> {
    return this.#serial(async () => {
      if (expected !== this.opened.fingerprint) throw new SourceChanged(CHANGED);
      const picked = Array.isArray(ranges) && ranges.length > 0;
      if (picked && !this.opened.selectable) {
        throw new FusenError(
          this.opened.kind === "duckdb" || this.opened.kind === "sqlite"
            ? "rows of a database table are selected by a column, such as where id = 5, not by position"
            : "this file has its own column named file_row_number, so rows cannot be selected by position",
        );
      }
      const kept = this.#keep(columns);
      const filter = await this.#filter(where);
      const positions = picked || (filter === undefined && kept === undefined) ? this.#positions(mergeRanges(ranges, this.opened.card.rows)) : undefined;
      // The filter sits alone on its lines, so a "--" comment in it cannot swallow what follows.
      const predicate = positions && filter ? `(${positions}) AND (\n${filter}\n)` : (positions ?? filter);
      // Minting compares the file's fingerprint with the one the page was shown.
      return mintRefWith(this.#engine, { where: predicate, columns: kept, expect: this.opened.fingerprint }).catch((error: unknown) => {
        throw error instanceof SourceChanged ? new SourceChanged(CHANGED) : error;
      });
    }, signal);
  }

  /** The predicate for selected positions, in the terms a Ref uses. */
  #positions(ranges: Range[]): string {
    return this.#layout ? layoutPredicate(ranges, this.#layout) : rangesPredicate(ranges);
  }

  /** Closes the engine once the operations already queued are done. */
  close(): Promise<void> {
    this.#closing ??= this.#serial(async () => {
      this.#closed = true;
      this.#engine.close();
    });
    return this.#closing;
  }
}
