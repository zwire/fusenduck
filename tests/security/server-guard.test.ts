import { DuckDBInstance } from "@duckdb/node-api";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { guardServerQuery } from "../../packages/core/src/guard.ts";

// The guard walks DuckDB's own parse tree, so these run against the real parser (no server needed).
let instance: DuckDBInstance;
let probe: (sql: string) => Promise<Record<string, unknown>[]>;
beforeAll(async () => {
  instance = await DuckDBInstance.create(":memory:");
  const connection = await instance.connect();
  probe = async (sql) => (await connection.runAndReadAll(sql)).getRowObjectsJson() as Record<string, unknown>[];
});
afterAll(() => instance.closeSync());

const refuses = (sql: string, message?: RegExp) => expect(guardServerQuery(sql, probe)).rejects.toThrow(message);

describe("the guard on queries over a database server (docs/adr/0005 section 6)", () => {
  it("lets ordinary SELECTs over data through", async () => {
    for (const sql of [
      "SELECT * FROM data",
      "SELECT id, count(*) FROM data WHERE id > 3 GROUP BY id ORDER BY 2 LIMIT 5",
      "WITH x AS (SELECT * FROM data) SELECT * FROM x",
      "SELECT * FROM data d JOIN range(3) r(i) ON d.id = r.i",
      "SELECT * FROM data WHERE id IN (SELECT id FROM data WHERE id < 3)",
      "SELECT (SELECT max(id) FROM data)",
      "SELECT * FROM (VALUES (1), (2)) v(i)",
    ]) await expect(guardServerQuery(sql, probe)).resolves.toBeUndefined();
  });

  it.each([
    ["a scanner function", "SELECT * FROM postgres_scan('host=other port=1 dbname=x', 'public', 't')", /postgres_scan/],
    ["a quoted, upper-case name", `SELECT * FROM "POSTGRES_SCAN"('h','public','t')`, /postgres_scan/],
    ["a schema-qualified name", "SELECT * FROM main.postgres_scan('h','public','t')", /postgres_scan/],
    ["a function inside a CTE", "WITH x AS (SELECT * FROM postgres_query('pg','select 1')) SELECT * FROM x", /postgres_query/],
    ["a function inside a scalar subquery", "SELECT (SELECT count(*) FROM mysql_scan('h','d','t'))", /mysql_scan/],
    ["a function inside a lateral join", "SELECT * FROM data, LATERAL (SELECT * FROM postgres_scan('h','public','t')) y", /postgres_scan/],
    ["a function inside an IN list", "SELECT * FROM data WHERE id IN (SELECT i FROM postgres_query('pg','select 1 as i'))", /postgres_query/],
    ["a catalog function", "SELECT * FROM duckdb_databases()", /duckdb_databases/],
    ["a settings function", "SELECT * FROM duckdb_settings()", /duckdb_settings/],
    ["a file reader", "SELECT * FROM read_csv('/etc/passwd')", /read_csv/],
    ["another relation", "SELECT * FROM pg.public.items", /another schema or catalog/],
    ["a catalog table", "SELECT * FROM information_schema.tables", /another schema or catalog/],
    ["a table that is not data", "SELECT * FROM items", /items/],
  ])("refuses %s", async (_name, sql, message) => {
    await refuses(sql, message);
  });

  it("refuses everything that is not one SELECT", async () => {
    for (const sql of [
      "ATTACH 'host=x' AS z (TYPE postgres)",
      "CALL postgres_execute('pg', 'select 1')",
      "PRAGMA database_list",
      "COPY (SELECT 1) TO 'x.csv'",
      "CREATE SECRET s (TYPE postgres)",
      "SET enable_external_access=true",
      "SELECT 1; SELECT 2",
      "INSTALL postgres",
      "SELECT 1; DETACH pg",
    ]) await refuses(sql, /single SELECT/);
  });

  it("does not take a function's name from a string", async () => {
    // A string that looks like a call is data, not a call.
    await expect(guardServerQuery("SELECT 'postgres_scan(1)' AS s FROM data", probe)).resolves.toBeUndefined();
  });
});
