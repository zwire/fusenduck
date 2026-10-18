import { realpathSync } from "node:fs";
import { relative, isAbsolute } from "node:path";
import { lit, openSource } from "./engine.ts";
import { fingerprint } from "./fingerprint.ts";
import { checkPredicate, formatRef, parseRef, selectionSql, type Ref } from "./ref.ts";
import { renderChanged, renderRows } from "./render.ts";

export const DEFAULT_LIMIT = 100;
/** Refuse to scan more than this many compressed bytes; a first default, see docs/adr/0001. */
export const DEFAULT_MAX_BYTES = 512 * 1024 * 1024;

/** A query on an untrusted predicate may run this long before it is stopped. */
export const DEFAULT_TIMEOUT_MS = 10_000;

export class CostExceeded extends Error {}

const inside = (root: string, path: string): boolean => {
  const rel = relative(root, path);
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
};

/** Throws unless the file is under one of the roots (symlinks resolved). */
export function assertInRoots(path: string, roots: string[]): void {
  const real = realpathSync(path);
  if (!roots.some((root) => inside(realpathSync(root), real))) {
    throw new Error(`the source is outside the allowed roots: ${path}`);
  }
}

export async function mintRef(source: string, opts: { where?: string; columns?: string[] } = {}): Promise<string> {
  const engine = await openSource(source);
  if (opts.where) await checkPredicate(engine, engine.source, opts.where);
  const ref: Ref = { source: engine.source, fingerprint: await fingerprint(engine) };
  if (opts.where) ref.where = opts.where;
  if (opts.columns?.length) ref.columns = opts.columns;
  // Plan it now (no rows read) so a missing column or a bad predicate fails here, not later.
  await engine.query(`${selectionSql(ref)} LIMIT 0`, { timeoutMs: DEFAULT_TIMEOUT_MS });
  return formatRef(ref);
}

export async function resolveRef(
  text: string,
  opts: { limit?: number; maxBytes?: number; timeoutMs?: number; roots: string[] },
): Promise<string> {
  const ref = parseRef(text);
  // A Ref names its own file, so a pasted Ref must not be able to point anywhere on disk.
  assertInRoots(ref.source, opts.roots);
  const engine = await openSource(ref.source);
  const now = await fingerprint(engine);
  if (now !== ref.fingerprint) return renderChanged(ref, now);
  if (ref.where) await checkPredicate(engine, engine.source, ref.where);

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
  if (!Number.isInteger(limit) || limit < 0) throw new Error("limit must be a non-negative integer");
  const total = Number((await engine.query(`SELECT count(*)::VARCHAR AS n FROM (${selection})`, { timeoutMs }))[0]?.n ?? 0);
  const rows = await engine.query(`${selection} LIMIT ${limit}`, { timeoutMs });
  return renderRows(ref, rows, total);
}
