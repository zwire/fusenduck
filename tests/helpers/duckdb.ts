import { DuckDBInstance } from "@duckdb/node-api";

// Writes a DuckDB database file with two tables, `people` (5 rows) and `other` (one row with a secret in it),
// plus `solo` when asked. The database is checkpointed and closed, so the file stands alone.
export async function writeDatabase(path: string, opts: { onlyPeople?: boolean; extraTable?: string } = {}): Promise<void> {
  const instance = await DuckDBInstance.create(path);
  const connection = await instance.connect();
  await connection.run("CREATE TABLE people(id BIGINT, name VARCHAR); INSERT INTO people SELECT i, 'n' || i FROM range(5) t(i)");
  if (!opts.onlyPeople) await connection.run("CREATE TABLE other(secret VARCHAR); INSERT INTO other VALUES ('SECRET')");
  if (opts.extraTable) await connection.run(`CREATE TABLE "${opts.extraTable.replaceAll('"', '""')}"(a INT)`);
  await connection.run("CHECKPOINT");
  connection.closeSync();
  instance.closeSync();
}
