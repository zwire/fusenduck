import { createHash } from "node:crypto";
import { statSync } from "node:fs";
import type { Engine } from "./engine.ts";
import { lit } from "./sql.ts";

/**
 * One kind of source. An adapter says how the source is read, how a change to it is noticed, how
 * much it costs to scan and how a row is pointed at; a kind that cannot answer all of these is not
 * supported. See docs/adr/0004.
 */
export interface SourceAdapter {
  /** The kind, as a Ref names it (`src=`). A Ref without `src=` is `parquet`. */
  readonly name: string;
  /** The table expression that reads `path`. */
  read(path: string): string;
  /** The paths the engine may read for this source, fixed at open time before the configuration is locked. */
  allowedPaths(path: string): string[];
  /** The column that exposes a row's position in the source, which a predicate may name. */
  readonly rowPosition: string;
  /** The base query of a source, with the row position when a predicate selects by it. */
  baseQuery(path: string, withPosition?: boolean): string;
  /** A short hash of the source's data, cheap to compute. A changed source gives another value. */
  fingerprint(engine: Engine): Promise<string>;
  /** How many bytes a scan of the whole source reads. */
  scanBytes(engine: Engine): Promise<number>;
}

/**
 * Parquet: the fingerprint is read from the footer only: row count, file size, and the
 * per-row-group statistics (min/max, null and distinct counts, sizes) of every column.
 * A rewrite that keeps the row count and the size but changes values changes these statistics.
 * Each column's fields are kept as a JSON list, so NULL and separator characters in values cannot collide.
 * The text of the statistics comes from the engine, so a DuckDB upgrade may change a fingerprint (an old Ref then
 * reads as DATA_CHANGED; Refs are experimental). It still misses a rewrite that leaves every statistic equal; see docs/adr/0001 (open items).
 */
export const parquet: SourceAdapter = {
  name: "parquet",
  read: (path) => `read_parquet(${lit(path)})`,
  allowedPaths: (path) => [path],
  rowPosition: "file_row_number",
  baseQuery(path, withPosition = false) {
    return withPosition ? `SELECT *, ${this.rowPosition} FROM ${this.read(path)}` : `SELECT * FROM ${this.read(path)}`;
  },
  async fingerprint(engine) {
    const rows = await engine.query(`SELECT num_rows::VARCHAR AS n FROM parquet_file_metadata(${lit(engine.source)})`);
    const stats = await engine.query(
      `SELECT md5(string_agg(to_json(list_value(row_group_id::VARCHAR, path_in_schema, stats_min, stats_max,
                                                  stats_null_count::VARCHAR, stats_distinct_count::VARCHAR,
                                                  total_compressed_size::VARCHAR, total_uncompressed_size::VARCHAR))::VARCHAR,
                           ';' ORDER BY row_group_id, column_id)) AS h
     FROM parquet_metadata(${lit(engine.source)})`,
    );
    const size = statSync(engine.source).size;
    return createHash("sha256").update(`${String(rows[0]?.n)}:${size}:${String(stats[0]?.h)}`).digest("hex").slice(0, 12);
  },
  async scanBytes(engine) {
    const meta = await engine.query(
      `SELECT sum(total_compressed_size)::VARCHAR AS bytes FROM parquet_metadata(${lit(engine.source)})`,
    );
    return Number(meta[0]?.bytes ?? 0);
  },
};

/** The adapter for a source. Parquet is the only kind so far. */
export function adapterFor(_path: string): SourceAdapter {
  return parquet;
}
