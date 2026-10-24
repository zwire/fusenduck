import { createHash } from "node:crypto";
import { ident, lit, type Engine } from "./engine.ts";
import { createAdapter, isPattern, SOURCE_KINDS, type SourceOptions } from "./source.ts";
import { FusenError } from "./errors.ts";
import { guardServerQuery } from "./guard.ts";

export interface Ref {
  /** Absolute path of the source file. */
  source: string;
  /**
   * A SELECT over the source, which it names `data`. Without one, the Ref selects the whole file.
   * Untrusted: see checkQuery.
   */
  query?: string;
  /** SQL predicate over the columns of the query (or of the file). Untrusted: see checkPredicate. */
  where?: string;
  columns?: string[];
  /** The kind of source. Absent means Parquet, which is what every Ref was before kinds existed (docs/adr/0004). */
  src?: string;
  /** The read settings of a text source, detected once when the Ref was minted. */
  options?: SourceOptions;
  /** Data fingerprint at the time the Ref was minted. */
  fingerprint: string;
  /** Hash of the selection's parsed form, so a Ref edited by hand can be told from one that was minted. */
  id?: string;
  /** The engine version the id was computed under; the id is only checked under the same version. */
  engine?: string;
}

const PREFIX = "fusen://file/";

export function formatRef(ref: Ref): string {
  const params = [`v=${ref.fingerprint}`];
  if (ref.src && ref.src !== "parquet") params.push(`src=${encodeURIComponent(ref.src)}`);
  for (const key of Object.keys(ref.options ?? {}).sort()) params.push(`opt.${encodeURIComponent(key)}=${encodeURIComponent(ref.options![key]!)}`);
  if (ref.engine) params.push(`e=${encodeURIComponent(ref.engine)}`);
  if (ref.id) params.push(`id=${ref.id}`);
  if (ref.query) params.push(`q=${encodeURIComponent(ref.query)}`);
  if (ref.columns?.length) params.push(`cols=${ref.columns.map(encodeURIComponent).join(",")}`);
  if (ref.where) params.push(`where=${encodeURIComponent(ref.where)}`);
  return `${PREFIX}${encodeURIComponent(ref.source)}?${params.join("&")}`;
}

export function parseRef(text: string): Ref {
  try {
    return parseRefUnchecked(text);
  } catch (error) {
    if (error instanceof FusenError) throw error;
    throw new FusenError(`malformed Ref: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function parseRefUnchecked(text: string): Ref {
  if (!text.startsWith(PREFIX)) throw new FusenError(`not a fusen:// Ref: ${text.slice(0, 40)}`);
  const rest = text.slice(PREFIX.length);
  const cut = rest.indexOf("?");
  const path = cut < 0 ? rest : rest.slice(0, cut);
  const query = cut < 0 ? "" : rest.slice(cut + 1);
  let source: string;
  const params = new Map<string, string>();
  try {
    source = decodeURIComponent(path);
    for (const part of query.split("&").filter(Boolean)) {
      const i = part.indexOf("=");
      if (i <= 0) throw new FusenError(`malformed parameter "${part}"`);
      const key = part.slice(0, i);
      if (params.has(key)) throw new FusenError(`duplicate parameter "${key}"`);
      params.set(key, part.slice(i + 1));
    }
  } catch (error) {
    throw new FusenError(`malformed Ref: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!source) throw new FusenError("Ref has no source");
  const fingerprint = params.get("v");
  if (!fingerprint) throw new FusenError("Ref has no fingerprint (v=)");
  const ref: Ref = { source, fingerprint };
  const cols = params.get("cols");
  if (cols) ref.columns = cols.split(",").map(decodeURIComponent);
  const where = params.get("where");
  if (where) ref.where = decodeURIComponent(where);
  const q = params.get("q");
  if (q) ref.query = decodeURIComponent(q);
  const src = params.get("src");
  if (src) {
    if (!SOURCE_KINDS.includes(src)) throw new FusenError(`unsupported source kind "${src}" (known: ${SOURCE_KINDS.join(", ")})`);
    if (src !== "parquet") ref.src = src;
  }
  const options: SourceOptions = {};
  for (const [key, value] of params) if (key.startsWith("opt.")) options[decodeURIComponent(key.slice(4))] = decodeURIComponent(value);
  if (Object.keys(options).length) ref.options = options;
  // Settings are checked now, so a Ref that carries bad ones is refused before anything is opened.
  createAdapter(ref.src, ref.options);
  const id = params.get("id");
  if (id) ref.id = id;
  const engine = params.get("e");
  if (engine) ref.engine = decodeURIComponent(engine);
  return ref;
}

// A query sits alone on its lines inside parentheses, like a predicate (see whereClause).
const base = (ref: Pick<Ref, "source" | "query" | "where" | "src" | "options">): string =>
  ref.query
    ? `\n${ref.query}\n`
    : isPattern(ref.source)
      ? // Several files are read through the views the engine made, which carry the filename and the position.
        `SELECT * FROM ${positional(ref) ? "data_pos" : "data"}`
      : createAdapter(ref.src, ref.options).baseQuery(ref.source, positional(ref));

/**
 * A predicate that names `file_row_number` selects rows by their position in the file, which lets
 * a table without a key be addressed. Only then is the position exposed, so every other Ref keeps
 * the SQL (and the id) it had. Positions are safe because the fingerprint refuses a changed file.
 * A file with a real column of that name keeps it: the predicate then reads the column, not the position.
 */
export const positional = (ref: Pick<Ref, "query" | "where">): boolean =>
  !ref.query && /\bfile_row_number\b/i.test(ref.where ?? "");

// The predicate sits alone on its lines inside parentheses: a "--" comment cannot swallow what
// follows it, and LIMIT, OFFSET, ORDER BY or a UNION written into it is a syntax error.
function whereClause(predicate: string | undefined): string {
  return predicate ? ` WHERE (\n${predicate}\n)` : "";
}

/** The SELECT a Ref stands for (no row limit). */
export function selectionSql(ref: Ref): string {
  const all = positional(ref) ? "* EXCLUDE (file_row_number)" : "*";
  const cols = ref.columns?.length ? ref.columns.map(ident).join(", ") : all;
  return `SELECT ${cols} FROM (${base(ref)})${whereClause(ref.where)}`;
}

/**
 * Rejects a predicate that is not a plain filter, before the engine runs anything. The predicate
 * is untrusted SQL: this is only an early reject. The engine lock is what keeps a predicate from
 * reading or writing anything else.
 */
export async function checkPredicate(
  engine: Engine,
  source: string,
  predicate: string,
  query?: string,
): Promise<void> {
  // A server's table is read through the view `data`; the file kinds only need something to parse.
  const kind = engine.adapter.server ? { src: engine.adapter.name, options: engine.adapter.options } : {};
  const sql = `SELECT * FROM (${base({ source, query, where: predicate, ...kind })})${whereClause(predicate)}`;
  const rows = await engine.query(`SELECT json_serialize_sql(${lit(sql)}) AS j`);
  const parsed = JSON.parse(String(rows[0]?.j)) as {
    error?: boolean;
    error_message?: string;
    statements?: { node?: { type?: string; modifiers?: unknown[] } }[];
  };
  if (parsed.error) throw new FusenError(`predicate rejected: ${parsed.error_message ?? "not a single SELECT"}`);
  if (engine.adapter.server) await guardServerQuery(sql, (text) => engine.query(text));
  const statements = parsed.statements ?? [];
  const node = statements[0]?.node;
  if (statements.length !== 1 || node?.type !== "SELECT_NODE" || node.modifiers?.length) {
    throw new FusenError("predicate rejected: it must stay a single plain SELECT");
  }
}

/**
 * Rejects a query that is not one SELECT, before the engine runs anything. Like a predicate, it
 * is untrusted SQL: this is an early reject, and the engine lock is what keeps it from reading or
 * writing anything but the source.
 */
export async function checkQuery(engine: Engine, query: string): Promise<void> {
  const sql = `SELECT * FROM (\n${query}\n)`;
  const rows = await engine.query(`SELECT json_serialize_sql(${lit(sql)}) AS j`);
  const parsed = JSON.parse(String(rows[0]?.j)) as {
    error?: boolean;
    error_message?: string;
    statements?: { node?: { type?: string; from_table?: { type?: string } } }[];
  };
  // The query must stay the subquery the wrapper made of it: text that closes the parenthesis early
  // and adds a UNION or another FROM turns the outer node into something else.
  const node = parsed.statements?.[0]?.node;
  if (parsed.error || parsed.statements?.length !== 1 || node?.type !== "SELECT_NODE" || node.from_table?.type !== "SUBQUERY") {
    throw new FusenError(`query rejected: ${parsed.error_message ?? "it must be a single SELECT"}`);
  }
  if (engine.adapter.server) await guardServerQuery(sql, (text) => engine.query(text));
}

export async function engineVersion(engine: Engine): Promise<string> {
  return String((await engine.query("SELECT version() AS v"))[0]?.v);
}

// The parsed form keeps long numeric literals as doubles, so two literals that differ in the last
// digits would hash alike. Their text goes into the hash as well.
const numericLiterals = (text: string | undefined): string[] => text?.match(/\d[\d_.eE+-]*/g) ?? [];

/**
 * The id of a selection: a hash of its parsed form (case and spacing do not change it), its
 * numeric literals as written, and the source path. It catches a Ref that was edited by accident;
 * it is not a signature, because anyone can drop it (`id=`, `e=`) or recompute it, and a Ref is
 * always checked and run under the engine lock whatever its id says. It does not detect queries
 * that mean the same in different words. Under another engine version the parsed form may differ,
 * so the Ref records the version.
 */
export async function refId(engine: Engine, ref: Ref): Promise<string> {
  const rows = await engine.query(`SELECT json_serialize_sql(${lit(selectionSql(ref))}) AS j`);
  const parsed = JSON.parse(String(rows[0]?.j)) as { error?: boolean };
  if (parsed.error) throw new FusenError("the selection could not be parsed");
  const form = JSON.stringify(parsed, (key, value) => (key === "query_location" ? undefined : value));
  const literals = [...numericLiterals(ref.query), "|", ...numericLiterals(ref.where)].join(",");
  return createHash("sha256").update(`${ref.source}\n${form}\n${literals}`).digest("hex").slice(0, 12);
}
