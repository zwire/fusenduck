import { resolve } from "node:path";
import {
  buildCard,
  checkPredicate,
  DEFAULT_TIMEOUT_MS,
  fingerprint,
  FusenError,
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
  /** False when the file has its own column named file_row_number, so positions cannot be selected. */
  selectable: boolean;
}

export interface Page {
  /** Each row's position in the file (from 0), or null when positions cannot be selected. */
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

export class View {
  #tail: Promise<unknown> = Promise.resolve();
  #closed = false;
  #closing: Promise<void> | undefined;
  /** The count of the last filter, so paging through its rows counts them once. */
  #counted: { where: string; n: number } | undefined;

  readonly opened: Opened;
  readonly #engine: Engine;
  readonly #columns: string[];

  private constructor(engine: Engine, opened: Opened, columns: string[]) {
    this.#engine = engine;
    this.opened = opened;
    this.#columns = columns;
  }

  /** Opens `path` (relative paths start at the first root) under `roots`. */
  static async open(path: string, roots: string[]): Promise<View> {
    if (typeof path !== "string" || path.trim() === "") throw new FusenError("give the path of a Parquet file");
    const engine = await openSource(resolve(roots[0] ?? process.cwd(), path), { roots });
    try {
      const described = await engine.query(`DESCRIBE SELECT * FROM read_parquet(${lit(engine.source)})`);
      const columns = described.map((c) => String(c.column_name));
      // A real column of that name shadows the position in a predicate (docs/adr/0001), and DuckDB
      // compares identifiers without case.
      const selectable = !columns.some((c) => c.toLowerCase() === "file_row_number");
      const fp = await fingerprint(engine);
      const card = await buildCard(engine);
      const ref = await mintRefWith(engine, { expect: fp });
      return new View(engine, { source: engine.source, fingerprint: fp, card, ref, selectable }, columns);
    } catch (error) {
      engine.close();
      throw error;
    }
  }

  /** Runs one operation at a time on the engine, which has one connection. */
  #serial<T>(work: () => Promise<T>): Promise<T> {
    const run = this.#tail.then(() => {
      if (this.#closed) throw new FusenError("this file was closed. Open it again.");
      return work();
    });
    this.#tail = run.catch(() => undefined);
    return run;
  }

  async #check(expected: unknown): Promise<void> {
    if (expected !== this.opened.fingerprint || (await fingerprint(this.#engine)) !== this.opened.fingerprint) {
      throw new SourceChanged(CHANGED);
    }
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
    await checkPredicate(this.#engine, this.#engine.source, text);
    const parsed = String((await this.#engine.query(`SELECT json_serialize_sql(${lit(`SELECT 1 WHERE (\n${text}\n)`)}) AS j`))[0]?.j);
    if (parsed.includes('"TABLE_FUNCTION"')) throw new FusenError("filter rejected: a filter may not read a table; use the file's columns");
    if (parsed.includes('"STAR"')) throw new FusenError("filter rejected: name the columns instead of * or COLUMNS(*)");
    try {
      await this.#engine.query(`DESCRIBE SELECT 1 FROM read_parquet(${lit(this.#engine.source)}) WHERE (\n${text}\n)`, {
        timeoutMs: DEFAULT_TIMEOUT_MS,
      });
    } catch (error) {
      const message = (error instanceof Error ? error.message : String(error)).split("\n")[0]!;
      if (!/^(Parser|Binder|Catalog) Error:/.test(message)) throw error;
      throw new FusenError(`filter rejected: ${message.slice(0, 300)}`);
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

  rows(expected: unknown, offset: unknown, limit: unknown = DEFAULT_PAGE_ROWS, where?: unknown): Promise<Page> {
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
      const source = `read_parquet(${lit(this.#engine.source)})`;
      // The filter sits alone on its lines, as in a Ref, so a "--" comment cannot swallow what follows.
      const matches = filter === undefined ? "" : `(\n${filter}\n)`;
      const matched = filter === undefined ? this.opened.card.rows : await this.#count(filter, `SELECT count(*)::VARCHAR AS n FROM ${source} WHERE ${matches}`);
      let sql: string;
      if (!this.opened.selectable) {
        sql = `SELECT ${cells.join(", ")} FROM ${source}${filter === undefined ? "" : ` WHERE ${matches}`} LIMIT ${n} OFFSET ${from}`;
      } else if (filter === undefined) {
        sql = `SELECT file_row_number::VARCHAR AS pos, ${cells.join(", ")} FROM ${source}
           WHERE file_row_number BETWEEN ${from} AND ${from + n - 1} ORDER BY file_row_number`;
      } else {
        // With a filter, the offset is the position to go on from; one row more says where the next page starts.
        sql = `SELECT file_row_number::VARCHAR AS pos, ${cells.join(", ")} FROM ${source}
           WHERE ${matches} AND file_row_number >= ${from} ORDER BY file_row_number LIMIT ${n + 1}`;
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
    });
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
  ref(expected: unknown, ranges: unknown, where?: unknown, columns?: unknown): Promise<string> {
    return this.#serial(async () => {
      if (expected !== this.opened.fingerprint) throw new SourceChanged(CHANGED);
      const picked = Array.isArray(ranges) && ranges.length > 0;
      if (picked && !this.opened.selectable) {
        throw new FusenError("this file has its own column named file_row_number, so rows cannot be selected by position");
      }
      const kept = this.#keep(columns);
      const filter = await this.#filter(where);
      const positions = picked || (filter === undefined && kept === undefined) ? rangesPredicate(mergeRanges(ranges, this.opened.card.rows)) : undefined;
      // The filter sits alone on its lines, so a "--" comment in it cannot swallow what follows.
      const predicate = positions && filter ? `(${positions}) AND (\n${filter}\n)` : (positions ?? filter);
      // Minting compares the file's fingerprint with the one the page was shown.
      return mintRefWith(this.#engine, { where: predicate, columns: kept, expect: this.opened.fingerprint }).catch((error: unknown) => {
        throw error instanceof SourceChanged ? new SourceChanged(CHANGED) : error;
      });
    });
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
