import { ident, lit, type Engine } from "./engine.ts";

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
  if (!text.startsWith(PREFIX)) throw new Error(`not a fusen:// Ref: ${text.slice(0, 40)}`);
  const [path = "", query = ""] = text.slice(PREFIX.length).split("?", 2) as [string, string?];
  const source = decodeURIComponent(path);
  if (!source) throw new Error("Ref has no source");
  const params = new Map(query.split("&").filter(Boolean).map((p) => {
    const i = p.indexOf("=");
    return [p.slice(0, i), p.slice(i + 1)] as const;
  }));
  const fingerprint = params.get("v");
  if (!fingerprint) throw new Error("Ref has no fingerprint (v=)");
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

/** The SELECT a Ref stands for (no row limit). */
export function selectionSql(ref: Ref): string {
  const cols = ref.columns?.length ? ref.columns.map(ident).join(", ") : "*";
  const where = ref.where ? ` WHERE ${ref.where}` : "";
  return `SELECT ${cols} FROM (${baseQuery(ref.source)})${where}`;
}

/**
 * Rejects a predicate that is not a plain filter, before the engine runs anything. The predicate
 * is untrusted SQL: this is only an early reject. The engine lock is what keeps a predicate from
 * reading or writing anything else.
 */
export async function checkPredicate(engine: Engine, source: string, predicate: string): Promise<void> {
  const sql = `SELECT * FROM (${baseQuery(source)}) WHERE ${predicate}`;
  const rows = await engine.query(`SELECT json_serialize_sql(${lit(sql)}) AS j`);
  const parsed = JSON.parse(String(rows[0]?.j)) as {
    error?: boolean;
    error_message?: string;
    statements?: { node?: { type?: string } }[];
  };
  if (parsed.error) throw new Error(`predicate rejected: ${parsed.error_message ?? "not a single SELECT"}`);
  const statements = parsed.statements ?? [];
  if (statements.length !== 1 || statements[0]?.node?.type !== "SELECT_NODE") {
    throw new Error("predicate rejected: it must stay a single plain SELECT");
  }
}
