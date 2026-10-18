import { createHash } from "node:crypto";
import { statSync } from "node:fs";
import { lit, type Engine } from "./engine.ts";

/**
 * A cheap fingerprint of the source's data, read from the Parquet footer only: row count, file size,
 * and the per-row-group statistics (min/max, null and distinct counts, sizes) of every column.
 * A rewrite that keeps the row count and the size but changes values changes these statistics.
 * It still misses a rewrite that leaves every statistic equal; see docs/adr/0001 (open items).
 */
export async function fingerprint(engine: Engine): Promise<string> {
  const rows = await engine.query(`SELECT num_rows::VARCHAR AS n FROM parquet_file_metadata(${lit(engine.source)})`);
  const stats = await engine.query(
    `SELECT md5(string_agg(concat_ws('|', row_group_id, path_in_schema, stats_min, stats_max, stats_null_count,
                                     stats_distinct_count, total_compressed_size, total_uncompressed_size),
                           ';' ORDER BY row_group_id, column_id)) AS h
     FROM parquet_metadata(${lit(engine.source)})`,
  );
  const size = statSync(engine.source).size;
  return createHash("sha256").update(`${String(rows[0]?.n)}:${size}:${String(stats[0]?.h)}`).digest("hex").slice(0, 12);
}
