import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { join } from "node:path";
import { DuckDBInstance } from "@duckdb/node-api";

const root = join(import.meta.dirname, "../..");

/** Builds the SPA (tsc into apps/web/dist), which the server reads when it starts. */
export function buildSpa(): void {
  const tsc = createRequire(import.meta.url).resolve("typescript/bin/tsc");
  execFileSync(process.execPath, [tsc, "-p", join(root, "apps/web/spa")], { stdio: "inherit" });
}

/** A Parquet file with its own column named file_row_number, which shadows the position. */
export async function writeOwnPositionColumn(path: string): Promise<void> {
  const connection = await (await DuckDBInstance.create(":memory:")).connect();
  await connection.run(`COPY (SELECT i AS id, i * 10 AS file_row_number FROM range(0, 20) t(i)) TO '${path}' (FORMAT parquet)`);
}

/** Calls the Web UI's API the way the SPA does. */
export async function call(
  base: string,
  path: string,
  body: unknown,
  opts: { token?: string; headers?: Record<string, string>; raw?: string } = {},
): Promise<{ status: number; body: Record<string, unknown>; headers: Headers }> {
  const headers: Record<string, string> = { "content-type": "application/json", ...opts.headers };
  if (opts.token) headers.authorization = `Bearer ${opts.token}`;
  const res = await fetch(new URL(path, base), { method: "POST", headers, body: opts.raw ?? JSON.stringify(body) });
  const text = await res.text();
  let parsed: Record<string, unknown> = {};
  try {
    parsed = JSON.parse(text) as Record<string, unknown>;
  } catch {
    parsed = { text };
  }
  return { status: res.status, body: parsed, headers: res.headers };
}

export const HOSTILE_CELLS = ['<img src=x onerror="window.__pwned=1">', "</script><script>window.__pwned=2</script>"];

/** 20 rows whose notes at positions 3 and 4 are markup that would run if it were parsed as HTML. */
export async function writeHostileMarkup(path: string): Promise<void> {
  const connection = await (await DuckDBInstance.create(":memory:")).connect();
  const [img, script] = HOSTILE_CELLS.map((s) => `'${s!.replaceAll("'", "''")}'`);
  await connection.run(`COPY (
    SELECT i AS id, CASE i WHEN 3 THEN ${img} WHEN 4 THEN ${script} ELSE 'note ' || i END AS note FROM range(0, 20) t(i)
  ) TO '${path}' (FORMAT parquet)`);
}
