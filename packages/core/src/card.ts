import { lit, type Engine } from "./engine.ts";
import { FusenError } from "./errors.ts";

export interface CardColumn {
  column: string;
  type: string;
  min: string | null;
  max: string | null;
  approx_unique: number;
  null_percentage: string;
  avg: string | null;
}

export interface DataCard {
  rows: number;
  columns: CardColumn[];
  /** Fields in each column that are estimates, not exact. */
  approximate: string[];
}

/** A card reads every row of the file; past this it is stopped, so a huge file cannot hold a caller forever. */
export const CARD_TIMEOUT_MS = 30_000;

const MAX_TEXT = 40;
const MAX_NAME = 80;

// A text column's min/max is a cell value, so it can carry instructions: keep it short.
function shorten(value: string | null, type: string): string | null {
  if (value === null || !/VARCHAR|TEXT|STRING/i.test(type)) return value;
  return value.length > MAX_TEXT ? `${value.slice(0, MAX_TEXT)}…` : value;
}

// Column names are source text too.
const clip = (value: string): string => (value.length > MAX_NAME ? `${value.slice(0, MAX_NAME)}…` : value);

export async function buildCard(engine: Engine, opts: { timeoutMs?: number } = {}): Promise<DataCard> {
  const timeoutMs = opts.timeoutMs ?? CARD_TIMEOUT_MS;
  let summary;
  try {
    summary = await engine.query(`SUMMARIZE SELECT * FROM read_parquet(${lit(engine.source)})`, { timeoutMs });
  } catch (error) {
    if (error instanceof FusenError && /stopped after/.test(error.message)) {
      throw new FusenError(`data card stopped after ${timeoutMs} ms: the file is too large to summarize in time`);
    }
    throw error;
  }
  const rows = Number(summary[0]?.count ?? 0);
  const columns = summary.map((c): CardColumn => {
    const type = String(c.column_type);
    return {
      column: clip(String(c.column_name)),
      type,
      min: shorten((c.min as string | null) ?? null, type),
      max: shorten((c.max as string | null) ?? null, type),
      // The estimate can exceed the row count; a distinct count never can.
      approx_unique: Math.min(Number(c.approx_unique), rows),
      null_percentage: String(c.null_percentage),
      avg: (c.avg as string | null) ?? null,
    };
  });
  return { rows, columns, approximate: ["approx_unique", "avg"] };
}
