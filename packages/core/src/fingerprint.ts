import { createHash } from "node:crypto";
import { statSync } from "node:fs";
import { lit, type Engine } from "./engine.ts";

/**
 * A cheap fingerprint of the source's data, read from the Parquet footer only: row count, file size,
 * and the per-row-group statistics (min/max, null and distinct counts, sizes) of every column.
 * A rewrite that keeps the row count and the size but changes values changes these statistics.
 * Each column's fields are kept as a JSON list, so NULL and separator characters in values cannot collide.
 * The text of the statistics comes from the engine, so a DuckDB upgrade may change a fingerprint (an old Ref then
 * reads as DATA_CHANGED; Refs are experimental). It still misses a rewrite that leaves every statistic equal; see docs/adr/0001 (open items).
 */
export async function fingerprint(engine: Engine): Promise<string> {
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
}
