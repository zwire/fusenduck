import { createHash } from "node:crypto";
import { statSync } from "node:fs";
import { lit, type Engine } from "./engine.ts";

/**
 * A cheap fingerprint of the source's data: row count (from the Parquet footer) and file size.
 * It misses a rewrite that keeps both the same; see docs/adr/0001 (open items).
 */
export async function fingerprint(engine: Engine): Promise<string> {
  const rows = await engine.query(`SELECT num_rows::VARCHAR AS n FROM parquet_file_metadata(${lit(engine.source)})`);
  const size = statSync(engine.source).size;
  return createHash("sha256").update(`${String(rows[0]?.n)}:${size}`).digest("hex").slice(0, 12);
}
