import { dirname } from "node:path";
import { lit, openSource, type Engine } from "./engine.ts";
import { FusenError } from "./errors.ts";
import { fingerprint } from "./fingerprint.ts";
import { baseQuery, checkPredicate, checkQuery, engineVersion, formatRef, parseRef, positional, refId, selectionSql, type Ref } from "./ref.ts";
import { buildCard } from "./card.ts";
import { renderCard, renderChanged, renderRows, type Ambiguity } from "./render.ts";

export const DEFAULT_LIMIT = 100;
/** Refuse to scan more than this many compressed bytes; a first default, see docs/adr/0001. */
export const DEFAULT_MAX_BYTES = 512 * 1024 * 1024;

/** A query on an untrusted predicate may run this long before it is stopped. */
export const DEFAULT_TIMEOUT_MS = 10_000;

export const DEFAULT_PEEK_ROWS = 5;
export const MAX_PEEK_ROWS = 50;

/**
 * Identical copies among the matching rows are counted only up to this many matches: the count
 * hashes every matching row, and a selection this large is not one an agent cites row by row.
 */
export const MAX_AMBIGUITY_ROWS = 10_000;

/**
 * Rows are read from the engine only up to this many bytes (each row measured as text). Rendering
 * cuts long cells, but only after the rows are in memory, and a query can make a cell of any size.
 */
export const MAX_FETCH_BYTES = 8 * 1024 * 1024;

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
  if (ref.query) await checkQuery(engine, ref.query);
  if (ref.where) await checkPredicate(engine, engine.source, ref.where, ref.query);
  const now = await fingerprint(engine);
  if (now !== ref.fingerprint) return renderChanged(ref, now);
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
  const fit = await rowsWithin(engine, selection, limit, timeoutMs);
  const rows = await engine.query(`${selection} LIMIT ${fit}`, { timeoutMs });
  const budget = fit < Math.min(limit, total) ? MAX_FETCH_BYTES : undefined;
  return renderRows(ref, rows, total, await countCopies(engine, ref, selection, total, timeoutMs), budget);
}

/** How many of the first `limit` rows fit in MAX_FETCH_BYTES. The sizes are measured in the engine, under the clock. */
async function rowsWithin(engine: Engine, selection: string, limit: number, timeoutMs: number): Promise<number> {
  // One size per cell; a text cell's size is read without copying it.
  const sizes = await engine.query(`SELECT strlen(CAST(COLUMNS(*) AS VARCHAR)) FROM (${selection} LIMIT ${limit})`, { timeoutMs });
  let bytes = 0;
  let fit = 0;
  for (const row of sizes) {
    bytes += Object.values(row).reduce<number>((sum, n) => sum + Number(n ?? 0), 0);
    if (bytes > MAX_FETCH_BYTES) break;
    fit += 1;
  }
  return fit;
}

/**
 * How many distinct rows a selection matched, so a Ref that matches identical copies can say it is
 * ambiguous. A Ref that already selects by position is not counted: it names its copies. The count
 * evaluates every matching cell, which the rows shown do not, so it is best effort: if it fails or
 * runs out of time or memory, the result is rendered without it, as before.
 */
async function countCopies(
  engine: Engine,
  ref: Ref,
  selection: string,
  total: number,
  timeoutMs: number,
): Promise<Ambiguity | undefined> {
  if (total < 2 || total > MAX_AMBIGUITY_ROWS || positional(ref)) return undefined;
  try {
    // DISTINCT * rather than a row alias, which a column of the same name would shadow.
    const n = (await engine.query(`SELECT count(*)::VARCHAR AS n FROM (SELECT DISTINCT * FROM (${selection}))`, { timeoutMs }))[0]?.n;
    if (n === undefined) return undefined;
    // A file with its own file_row_number column reads that column in a predicate, not the position.
    const own = ref.query
      ? []
      : await engine.query(`SELECT 1 FROM (DESCRIBE ${baseQuery(engine.source)}) WHERE column_name = 'file_row_number'`);
    return { distinct: Number(n), byPosition: !ref.query && own.length === 0 };
  } catch {
    return undefined;
  }
}

/**
 * The first look at a file in one result: its data card, then the first rows with the Ref that
 * stands for them (the whole file), so an agent can cite what it saw.
 */
export async function peek(
  source: string,
  opts: { rows?: number; roots?: string[] } = {},
): Promise<string> {
  const rows = opts.rows ?? DEFAULT_PEEK_ROWS;
  if (!Number.isInteger(rows) || rows < 0 || rows > MAX_PEEK_ROWS) {
    throw new FusenError(`rows must be an integer from 0 to ${MAX_PEEK_ROWS}`);
  }
  const engine = await openSource(source, { roots: opts.roots });
  const card = renderCard(await buildCard(engine), engine.source);
  const ref = await mintRef(source, { roots: opts.roots });
  // The Ref was just minted from this file, so resolving it may read this file's own directory.
  return `${card}\n${await resolveRef(ref, { limit: rows, roots: opts.roots ?? [dirname(engine.source)] })}`;
}
