import type { Engine } from "./engine.ts";
import { FusenError } from "./errors.ts";
import { holdsText, keyKind, mask, maskText, nameKind, orderKinds, type Masked } from "./pii.ts";

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
  /** Columns whose min/max were hidden as personal data (empty when unmasked). */
  masked: Masked[];
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

/** Hides a column's min, max and avg when its name or their shape says personal data; records why in `masked`. */
function maskBounds(column: CardColumn, position: number, masked: Masked[]): CardColumn {
  const kind = nameKind(column.column);
  if (kind) {
    if (column.min === null && column.max === null && column.avg === null) return column;
    masked.push({ column: column.column, position, kinds: [kind], by: "name" });
    const hide = (value: string | null) => (value === null ? null : mask(kind));
    return { ...column, min: hide(column.min), max: hide(column.max), avg: hide(column.avg) };
  }
  if (!holdsText(column.type)) return column;
  const found = new Set<string>();
  // A nested bound is a whole value: a key named like personal data hides all of it, since the
  // card's cut to 40 characters would still show the start of what the key holds.
  const bound = (value: string | null) => {
    if (value === null) return null;
    const kind = keyKind(value, column.type);
    if (!kind) return maskText(value, found);
    found.add(kind);
    return mask(kind);
  };
  const min = bound(column.min);
  const max = bound(column.max);
  if (found.size) masked.push({ column: column.column, position, kinds: orderKinds(found), by: "value" });
  return { ...column, min, max };
}

/** `unmask` shows min/max that look like personal data; only whoever runs fusenduck may ask for it. */
export async function buildCard(engine: Engine, opts: { timeoutMs?: number; unmask?: boolean } = {}): Promise<DataCard> {
  const timeoutMs = opts.timeoutMs ?? CARD_TIMEOUT_MS;
  let summary;
  try {
    summary = await engine.query(`SUMMARIZE SELECT * FROM data`, { timeoutMs });
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
      min: (c.min as string | null) ?? null,
      max: (c.max as string | null) ?? null,
      // The estimate can exceed the row count; a distinct count never can.
      approx_unique: Math.min(Number(c.approx_unique), rows),
      null_percentage: String(c.null_percentage),
      avg: (c.avg as string | null) ?? null,
    };
  });
  const masked: Masked[] = [];
  // Masked before they are cut, so a cut cannot break the shape that gives a value away.
  const shown = (opts.unmask ? columns : columns.map((c, i) => maskBounds(c, i + 1, masked))).map((c) => ({
    ...c,
    min: shorten(c.min, c.type),
    max: shorten(c.max, c.type),
  }));
  return { rows, columns: shown, approximate: ["approx_unique", "avg"], masked };
}
