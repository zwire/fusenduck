import { lit, type Engine } from "./engine.ts";

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

const MAX_TEXT = 40;

// A text column's min/max is a cell value, so it can carry instructions: keep it short.
function shorten(value: string | null, type: string): string | null {
  if (value === null || !/VARCHAR|TEXT|STRING/i.test(type)) return value;
  return value.length > MAX_TEXT ? `${value.slice(0, MAX_TEXT)}…` : value;
}

export async function buildCard(engine: Engine): Promise<DataCard> {
  const summary = await engine.query(`SUMMARIZE SELECT * FROM read_parquet(${lit(engine.source)})`);
  const rows = Number(summary[0]?.count ?? 0);
  const columns = summary.map((c): CardColumn => {
    const type = String(c.column_type);
    return {
      column: String(c.column_name),
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
