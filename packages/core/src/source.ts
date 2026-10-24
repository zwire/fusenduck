import { createHash } from "node:crypto";
import { constants, statSync } from "node:fs";
import { open } from "node:fs/promises";
import { basename } from "node:path";
import type { Engine, Row } from "./engine.ts";
import { FusenError } from "./errors.ts";
import { lit } from "./sql.ts";

/** A source that names several files: a wildcard (`*`, `?`) in the file name, never in a directory. */
export const isPattern = (source: string): boolean => /[*?]/.test(source.split(/[\\/]/).pop() ?? "");

/** A SQL list of the files, which the engine reads as one table. */
const list = (files: string[]): string => `[${files.map(lit).join(", ")}]`;

/** The read settings of a source, as a Ref carries them (`opt.<name>=<value>`, docs/adr/0004). */
export type SourceOptions = Record<string, string>;

/** Runs one statement while a source is being opened, before the engine is locked. */
export type Probe = (sql: string) => Promise<Row[]>;

/**
 * One kind of source. An adapter says how the source is read, how a change to it is noticed, how
 * much it costs to scan and how a row is pointed at; a kind that cannot answer all of these is not
 * supported. See docs/adr/0004.
 */
export interface SourceAdapter {
  /** The kind, as a Ref names it (`src=`). A Ref without `src=` is `parquet`. */
  readonly name: string;
  /** The read settings that change what the source returns. Empty when the kind has none or they are not detected yet. */
  readonly options: SourceOptions;
  /**
   * Fills in what a kind detects (CSV delimiter and types, JSON columns), once, while the source is opened.
   * Settings a Ref already carries are never detected again, so the same Ref reads the same on any machine.
   */
  resolve(path: string, probe: Probe): Promise<SourceAdapter>;
  /** The table expression that reads the files. With several, each row also carries the `filename` it came from. */
  read(files: string[], multi?: boolean): string;
  /** The paths the engine may read for this source, fixed at open time before the configuration is locked. */
  allowedPaths(files: string[]): string[];
  /** For several files: every row with its `filename` and `file_row_number` (its position within that file). */
  positionView(files: string[]): string;
  /** The column that exposes a row's position in the source, which a predicate may name. */
  readonly rowPosition: string;
  /** The base query of a source, with the row position when a predicate selects by it. */
  baseQuery(path: string, withPosition?: boolean): string;
  /** A short hash of the source's data, cheap to compute. A changed source gives another value. */
  fingerprint(engine: Engine): Promise<string>;
  /** How many bytes a scan of the whole source reads. */
  scanBytes(engine: Engine): Promise<number>;
}

/**
 * The fingerprint of a source that may be several files: one file keeps the fingerprint it always had; several
 * are the list of files with each file's own, so a file added, removed, renamed or changed gives another value.
 */
async function perFile(engine: Engine, one: (path: string) => Promise<string>): Promise<string> {
  if (!engine.multi) return one(engine.files[0]!);
  const parts: [string, string][] = [];
  // By file name: the files share one directory, and the same files elsewhere keep the same fingerprint.
  for (const path of engine.files) parts.push([basename(path), await one(path)]);
  return createHash("sha256").update(`files:${JSON.stringify(parts)}`).digest("hex").slice(0, 12);
}

async function parquetFingerprint(engine: Engine, path: string): Promise<string> {
  const rows = await engine.query(`SELECT num_rows::VARCHAR AS n FROM parquet_file_metadata(${lit(path)})`);
  const stats = await engine.query(
    `SELECT md5(string_agg(to_json(list_value(row_group_id::VARCHAR, path_in_schema, stats_min, stats_max,
                                                  stats_null_count::VARCHAR, stats_distinct_count::VARCHAR,
                                                  total_compressed_size::VARCHAR, total_uncompressed_size::VARCHAR))::VARCHAR,
                           ';' ORDER BY row_group_id, column_id)) AS h
     FROM parquet_metadata(${lit(path)})`,
  );
  const size = statSync(path).size;
  return createHash("sha256").update(`${String(rows[0]?.n)}:${size}:${String(stats[0]?.h)}`).digest("hex").slice(0, 12);
}

/**
 * Parquet: the fingerprint is read from the footer only: row count, file size, and the
 * per-row-group statistics (min/max, null and distinct counts, sizes) of every column.
 * A rewrite that keeps the row count and the size but changes values changes these statistics.
 * Each column's fields are kept as a JSON list, so NULL and separator characters in values cannot collide.
 * The text of the statistics comes from the engine, so a DuckDB upgrade may change a fingerprint (an old Ref then
 * reads as DATA_CHANGED; Refs are experimental). It still misses a rewrite that leaves every statistic equal; see docs/adr/0001 (open items).
 */
export const parquet: SourceAdapter = {
  name: "parquet",
  options: {},
  resolve: async () => parquet,
  read: (files, multi = false) => (multi ? `read_parquet(${list(files)}, filename=true)` : `read_parquet(${lit(files[0]!)})`),
  allowedPaths: (files) => files,
  positionView: (files) => `SELECT * FROM read_parquet(${list(files)}, filename=true, file_row_number=true)`,
  rowPosition: "file_row_number",
  baseQuery(path, withPosition = false) {
    return withPosition ? `SELECT *, ${this.rowPosition} FROM ${this.read([path])}` : `SELECT * FROM ${this.read([path])}`;
  },
  fingerprint: (engine) => perFile(engine, (path) => parquetFingerprint(engine, path)),
  async scanBytes(engine) {
    let total = 0;
    for (const path of engine.files) {
      const meta = await engine.query(`SELECT sum(total_compressed_size)::VARCHAR AS bytes FROM parquet_metadata(${lit(path)})`);
      total += Number(meta[0]?.bytes ?? 0);
    }
    return total;
  },
};

/** The most a text source may weigh and still be fingerprinted: the fingerprint hashes every byte. */
export const FINGERPRINT_MAX_BYTES = 512 * 1024 * 1024;

/**
 * A hash of the bytes of a file that has no footer to read. The file is opened without blocking and
 * checked once opened, so a path swapped for a pipe after it was checked cannot hang the reader.
 */
async function hashFile(path: string): Promise<string> {
  const file = await open(path, constants.O_RDONLY | constants.O_NONBLOCK);
  try {
    const info = await file.stat();
    if (!info.isFile()) throw new FusenError(`cannot read ${path}: it is not a regular file`);
    if (info.size > FINGERPRINT_MAX_BYTES) {
      throw new FusenError(`${path} is ${info.size} bytes, over the ${FINGERPRINT_MAX_BYTES} a text source may have to be fingerprinted`);
    }
    const hash = createHash("sha256");
    for await (const chunk of file.createReadStream({ autoClose: false, start: 0 })) hash.update(chunk as Buffer);
    return hash.digest("hex");
  } finally {
    await file.close();
  }
}

type Pairs = [string, string][];

/** The columns of a text source, as `columns` carries them: a JSON list of [name, type]. */
function parseColumns(text: string): Pairs {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new FusenError("opt.columns is not valid JSON");
  }
  const ok =
    Array.isArray(parsed) &&
    parsed.length > 0 &&
    parsed.length <= 4096 &&
    parsed.every((p) => Array.isArray(p) && p.length === 2 && typeof p[0] === "string" && typeof p[1] === "string" && p[1].length <= 512);
  if (!ok) throw new FusenError("opt.columns must be a list of [name, type] pairs");
  return parsed as Pairs;
}

const columnMap = (pairs: Pairs): string => `{${pairs.map(([n, t]) => `${lit(n)}: ${lit(t)}`).join(", ")}}`;

function checkKeys(kind: string, options: SourceOptions, allowed: string[]): void {
  for (const key of Object.keys(options)) {
    if (!allowed.includes(key)) throw new FusenError(`${kind} sources do not take the setting opt.${key}`);
  }
}

/** What a text source is made of: how to read it with the settings, how to detect them, and which ones exist. */
interface TextKind {
  name: string;
  keys: string[];
  /** Normalizes and validates settings from a Ref (throws a FusenError); returns them as they will be stored. */
  validate(options: SourceOptions): SourceOptions;
  /** The table function call with every setting spelled out. */
  call(files: string[], options: SourceOptions, multi: boolean): string;
  detect(path: string, probe: Probe): Promise<SourceOptions>;
}

const single = (name: string, value: string, max: number): string => {
  if (value.length > max || /[\r\n]/.test(value)) throw new FusenError(`opt.${name} must be at most ${max} character${max === 1 ? "" : "s"} and not a line break`);
  return value;
};

/** Settings sniffed only when the file has them. Everything else is always carried. */
const OPTIONAL_CSV = ["skip", "dateformat", "timestampformat"];

const csvKind: TextKind = {
  name: "csv",
  keys: ["delim", "quote", "escape", "header", "columns", "skip", "dateformat", "timestampformat"],
  validate(options) {
    checkKeys("csv", options, this.keys);
    const out: SourceOptions = {};
    for (const key of this.keys) {
      const value = options[key];
      if (value === undefined && OPTIONAL_CSV.includes(key)) continue;
      if (value === undefined) throw new FusenError(`csv sources need opt.${key}`);
      if (key === "delim") out[key] = single(key, value, 8);
      else if (key === "quote" || key === "escape") out[key] = single(key, value, 1);
      else if (key === "skip") {
        if (!/^\d{1,6}$/.test(value)) throw new FusenError("opt.skip must be a number of lines");
        out[key] = value;
      } else if (key === "dateformat" || key === "timestampformat") out[key] = single(key, value, 64);
      else if (key === "header") {
        if (value !== "true" && value !== "false") throw new FusenError("opt.header must be true or false");
        out[key] = value;
      } else out[key] = JSON.stringify(parseColumns(value));
    }
    if (out.delim === "") throw new FusenError("opt.delim must not be empty");
    return out;
  },
  // Nothing is left to detection at read time: what the sniffer would have decided is in the Ref, and the
  // two NULL rules (an empty field, and a quoted empty field) are spelled out rather than left to defaults.
  call: (files, o, multi) =>
    `read_csv(${multi ? list(files) : lit(files[0]!)}, auto_detect=false, delim=${lit(o.delim!)}, quote=${lit(o.quote!)}, escape=${lit(o.escape!)}, header=${o.header}, ` +
    `nullstr='', allow_quoted_nulls=true${o.skip ? `, skip=${o.skip}` : ""}${o.dateformat ? `, dateformat=${lit(o.dateformat)}` : ""}` +
    `${o.timestampformat ? `, timestampformat=${lit(o.timestampformat)}` : ""}${multi ? ", filename=true" : ""}, columns=${columnMap(parseColumns(o.columns!))})`,
  async detect(path, probe) {
    const rows = await probe(`SELECT Delimiter, Quote, Escape, HasHeader, Columns, SkipRows, DateFormat, TimestampFormat FROM sniff_csv(${lit(path)}, sample_size=-1)`);
    const r = rows[0];
    if (!r) throw new FusenError(`cannot work out the layout of ${path}`);
    const columns = (r.Columns as { name: string; type: string }[]).map((c): [string, string] => [c.name, c.type]);
    const found: SourceOptions = {
      delim: String(r.Delimiter),
      quote: r.Quote === "(empty)" ? "" : String(r.Quote),
      escape: r.Escape === "(empty)" ? "" : String(r.Escape),
      header: String(r.HasHeader === true || r.HasHeader === "true"),
      columns: JSON.stringify(columns),
    };
    if (Number(r.SkipRows) > 0) found.skip = String(r.SkipRows);
    if (r.DateFormat) found.dateformat = String(r.DateFormat);
    if (r.TimestampFormat) found.timestampformat = String(r.TimestampFormat);
    return found;
  },
};

const jsonKind = (name: string, format: string): TextKind => ({
  name,
  keys: ["columns"],
  validate(options) {
    checkKeys(name, options, this.keys);
    if (options.columns === undefined) throw new FusenError(`${name} sources need opt.columns`);
    return { columns: JSON.stringify(parseColumns(options.columns)) };
  },
  call: (files, o, multi) =>
    `read_json(${multi ? list(files) : lit(files[0]!)}, format=${lit(format)}${multi ? ", filename=true" : ""}, columns=${columnMap(parseColumns(o.columns!))})`,
  async detect(path, probe) {
    const rows = await probe(`DESCRIBE SELECT * FROM read_json(${lit(path)}, format=${lit(format)}, sample_size=-1)`);
    if (rows.length === 0) throw new FusenError(`cannot work out the columns of ${path}`);
    return { columns: JSON.stringify(rows.map((r): [string, string] => [String(r.column_name), String(r.column_type)])) };
  },
});

/**
 * A text source (CSV, JSON): no footer to read, so the fingerprint is a hash of the bytes together
 * with the settings, the settings are detected once and then carried by the Ref, and a row's position
 * is its index among the records, counted from 0 as Parquet's is.
 */
function textAdapter(kind: TextKind, options: SourceOptions, detected: boolean): SourceAdapter {
  const adapter: SourceAdapter = {
    name: kind.name,
    options,
    async resolve(path, probe) {
      return detected ? adapter : textAdapter(kind, kind.validate(await kind.detect(path, probe)), true);
    },
    read: (files, multi = false) => kind.call(files, options, multi),
    allowedPaths: (files) => files,
    // One read per file, joined in file order: a position counted with a window over all files would not keep
    // the rows of a file in order (the engine reads files in parallel).
    positionView: (files) =>
      files
        .map((file) => `SELECT *, row_number() OVER () - 1 AS ${adapter.rowPosition} FROM ${kind.call([file], options, true)}`)
        .join(" UNION ALL "),
    rowPosition: "file_row_number",
    baseQuery(path, withPosition = false) {
      return withPosition
        ? `SELECT *, row_number() OVER () - 1 AS ${this.rowPosition} FROM ${this.read([path])}`
        : `SELECT * FROM ${this.read([path])}`;
    },
    async fingerprint(engine) {
      const canonical = JSON.stringify(Object.keys(options).sort().map((k) => [k, options[k]]));
      const total = engine.files.reduce((sum, path) => sum + statSync(path).size, 0);
      if (total > FINGERPRINT_MAX_BYTES) throw new FusenError(`the files weigh ${total} bytes, over the ${FINGERPRINT_MAX_BYTES} a text source may have to be fingerprinted`);
      const content = await perFile(engine, hashFile);
      return createHash("sha256").update(`${kind.name}:${canonical}:${content}`).digest("hex").slice(0, 12);
    },
    scanBytes: async (engine) => engine.files.reduce((sum, path) => sum + statSync(path).size, 0),
  };
  return adapter;
}

const kinds: Record<string, TextKind> = {
  csv: csvKind,
  ndjson: jsonKind("ndjson", "newline_delimited"),
  json: jsonKind("json", "auto"),
};

/** The kinds a Ref may name in `src=`. */
export const SOURCE_KINDS = ["parquet", ...Object.keys(kinds)];

/** The kind a file name suggests. Anything not recognised is Parquet, as every source was before kinds existed. */
export function kindOf(path: string): string {
  if (/\.(csv|tsv)$/i.test(path)) return "csv";
  if (/\.(ndjson|jsonl)$/i.test(path)) return "ndjson";
  if (/\.json$/i.test(path)) return "json";
  return "parquet";
}

/**
 * The adapter for a kind and the settings a Ref gave. Without settings a text source detects them when
 * it is opened. Settings are checked here, because they come from a Ref, which is untrusted.
 */
export function createAdapter(name = "parquet", options?: SourceOptions): SourceAdapter {
  if (name === "parquet") {
    if (options && Object.keys(options).length) throw new FusenError("parquet sources take no settings");
    return parquet;
  }
  const kind = kinds[name];
  if (!kind) throw new FusenError(`unsupported source kind "${name}" (known: ${SOURCE_KINDS.join(", ")})`);
  return options && Object.keys(options).length
    ? textAdapter(kind, kind.validate(options), true)
    : textAdapter(kind, {}, false);
}
