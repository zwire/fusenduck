import { lit, openSource } from "./engine.ts";
import { fingerprint } from "./fingerprint.ts";
import { checkPredicate, formatRef, parseRef, selectionSql, type Ref } from "./ref.ts";
import { renderChanged, renderRows } from "./render.ts";

export const DEFAULT_LIMIT = 100;
/** Refuse to scan more than this many compressed bytes; a first default, see docs/adr/0001. */
export const DEFAULT_MAX_BYTES = 512 * 1024 * 1024;

export class CostExceeded extends Error {}

export async function mintRef(source: string, opts: { where?: string; columns?: string[] } = {}): Promise<string> {
  const engine = await openSource(source);
  if (opts.where) await checkPredicate(engine, engine.source, opts.where);
  const ref: Ref = { source: engine.source, fingerprint: await fingerprint(engine) };
  if (opts.where) ref.where = opts.where;
  if (opts.columns?.length) ref.columns = opts.columns;
  return formatRef(ref);
}

export async function resolveRef(
  text: string,
  opts: { limit?: number; maxBytes?: number } = {},
): Promise<string> {
  const ref = parseRef(text);
  const engine = await openSource(ref.source);
  const now = await fingerprint(engine);
  if (now !== ref.fingerprint) return renderChanged(ref, now);
  if (ref.where) await checkPredicate(engine, engine.source, ref.where);

  // The guard looks at the whole selection (source plus predicate), before anything is read.
  const meta = await engine.query(
    `SELECT sum(total_compressed_size)::VARCHAR AS bytes FROM parquet_metadata(${lit(engine.source)})`,
  );
  const bytes = Number(meta[0]?.bytes ?? 0);
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;
  if (bytes > maxBytes) throw new CostExceeded(`would scan ${bytes} bytes, over the limit of ${maxBytes}`);

  const selection = selectionSql(ref);
  const total = Number((await engine.query(`SELECT count(*)::VARCHAR AS n FROM (${selection})`))[0]?.n ?? 0);
  const rows = await engine.query(`${selection} LIMIT ${Math.max(0, Math.floor(opts.limit ?? DEFAULT_LIMIT))}`);
  return renderRows(ref, rows, total);
}
