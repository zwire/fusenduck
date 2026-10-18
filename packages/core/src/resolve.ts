import { lit, openSource } from "./engine.ts";
import { FusenError } from "./errors.ts";
import { fingerprint } from "./fingerprint.ts";
import { checkPredicate, checkQuery, engineVersion, formatRef, parseRef, refId, selectionSql, type Ref } from "./ref.ts";
import { renderChanged, renderRows } from "./render.ts";

export const DEFAULT_LIMIT = 100;
/** Refuse to scan more than this many compressed bytes; a first default, see docs/adr/0001. */
export const DEFAULT_MAX_BYTES = 512 * 1024 * 1024;

/** A query on an untrusted predicate may run this long before it is stopped. */
export const DEFAULT_TIMEOUT_MS = 10_000;

export class CostExceeded extends FusenError {}

export async function mintRef(
  source: string,
  opts: { query?: string; where?: string; columns?: string[]; roots?: string[] } = {},
): Promise<string> {
  const engine = await openSource(source, { roots: opts.roots });
  if (opts.query) await checkQuery(engine, opts.query);
  if (opts.where) await checkPredicate(engine, engine.source, opts.where, opts.query);
  const ref: Ref = { source: engine.source, fingerprint: await fingerprint(engine) };
  if (opts.query) ref.query = opts.query;
  if (opts.where) ref.where = opts.where;
  if (opts.columns?.length) ref.columns = opts.columns;
  // Plan it now (no rows read) so a missing column or a bad predicate fails here, not later.
  await engine.query(`${selectionSql(ref)} LIMIT 0`, { timeoutMs: DEFAULT_TIMEOUT_MS });
  ref.engine = await engineVersion(engine);
  ref.id = await refId(engine, ref);
  return formatRef(ref);
}

export async function resolveRef(
  text: string,
  opts: { limit?: number; maxBytes?: number; timeoutMs?: number; roots: string[] },
): Promise<string> {
  const ref = parseRef(text);
  // A Ref names its own file, so a pasted Ref must not be able to point anywhere on disk.
  const engine = await openSource(ref.source, { roots: opts.roots });
  const now = await fingerprint(engine);
  if (now !== ref.fingerprint) return renderChanged(ref, now);
  if (ref.query) await checkQuery(engine, ref.query);
  if (ref.where) await checkPredicate(engine, engine.source, ref.where, ref.query);
  // A Ref edited after it was minted no longer hashes to its id. (Skipped under another engine version.)
  if (ref.id && ref.engine === (await engineVersion(engine)) && ref.id !== (await refId(engine, ref))) {
    throw new FusenError("the Ref's id does not match its selection: it was edited after it was minted");
  }

  // The byte guard counts the whole source (a predicate cannot make a scan bigger than the file);
  // the clock below is what bounds a predicate that is slow without reading much.
  const meta = await engine.query(
    `SELECT sum(total_compressed_size)::VARCHAR AS bytes FROM parquet_metadata(${lit(engine.source)})`,
  );
  const bytes = Number(meta[0]?.bytes ?? 0);
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;
  if (bytes > maxBytes) throw new CostExceeded(`would scan ${bytes} bytes, over the limit of ${maxBytes}`);

  const selection = selectionSql(ref);
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const limit = opts.limit ?? DEFAULT_LIMIT;
  if (!Number.isInteger(limit) || limit < 0) throw new FusenError("limit must be a non-negative integer");
  const total = Number((await engine.query(`SELECT count(*)::VARCHAR AS n FROM (${selection})`, { timeoutMs }))[0]?.n ?? 0);
  const rows = await engine.query(`${selection} LIMIT ${limit}`, { timeoutMs });
  return renderRows(ref, rows, total);
}
