import { ident, lit, type Engine } from "./engine.ts";
import { FusenError } from "./errors.ts";

export interface Ref {
  /** Absolute path of the source file. */
  source: string;
  /** SQL predicate over the source's columns. Untrusted: see checkPredicate. */
  where?: string;
  columns?: string[];
  /** Data fingerprint at the time the Ref was minted. */
  fingerprint: string;
}

const PREFIX = "fusen://file/";

export function formatRef(ref: Ref): string {
  const params = [`v=${ref.fingerprint}`];
  if (ref.columns?.length) params.push(`cols=${ref.columns.map(encodeURIComponent).join(",")}`);
  if (ref.where) params.push(`where=${encodeURIComponent(ref.where)}`);
  return `${PREFIX}${encodeURIComponent(ref.source)}?${params.join("&")}`;
}

export function parseRef(text: string): Ref {
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
  return ref;
}

/** The base query of a source. */
export function baseQuery(source: string): string {
  return `SELECT * FROM read_parquet(${lit(source)})`;
}

// The predicate sits alone on its lines inside parentheses: a "--" comment cannot swallow what
// follows it, and LIMIT, OFFSET, ORDER BY or a UNION written into it is a syntax error.
function whereClause(predicate: string | undefined): string {
  return predicate ? ` WHERE (\n${predicate}\n)` : "";
}

/** The SELECT a Ref stands for (no row limit). */
export function selectionSql(ref: Ref): string {
  const cols = ref.columns?.length ? ref.columns.map(ident).join(", ") : "*";
  return `SELECT ${cols} FROM (${baseQuery(ref.source)})${whereClause(ref.where)}`;
}

/**
 * Rejects a predicate that is not a plain filter, before the engine runs anything. The predicate
 * is untrusted SQL: this is only an early reject. The engine lock is what keeps a predicate from
 * reading or writing anything else.
 */
export async function checkPredicate(engine: Engine, source: string, predicate: string): Promise<void> {
  const sql = `SELECT * FROM (${baseQuery(source)})${whereClause(predicate)}`;
  const rows = await engine.query(`SELECT json_serialize_sql(${lit(sql)}) AS j`);
  const parsed = JSON.parse(String(rows[0]?.j)) as {
    error?: boolean;
    error_message?: string;
    statements?: { node?: { type?: string; modifiers?: unknown[] } }[];
  };
  if (parsed.error) throw new FusenError(`predicate rejected: ${parsed.error_message ?? "not a single SELECT"}`);
  const statements = parsed.statements ?? [];
  const node = statements[0]?.node;
  if (statements.length !== 1 || node?.type !== "SELECT_NODE" || node.modifiers?.length) {
    throw new FusenError("predicate rejected: it must stay a single plain SELECT");
  }
}
