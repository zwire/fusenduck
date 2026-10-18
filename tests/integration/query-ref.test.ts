import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { DuckDBInstance } from "@duckdb/node-api";
import { parseRef } from "@fusenduck/core";
import { tempDir, writeCustomers } from "../helpers/fixtures.ts";

const cli = join(import.meta.dirname, "../../packages/cli/src/index.ts");
const run = (...args: string[]) => spawnSync("node", [cli, ...args], { encoding: "utf8" });

const BY_REGION = "SELECT region, round(sum(amount), 2) AS total FROM data GROUP BY region";

describe("a Ref that carries its query and an id", () => {
  const dir = tempDir();
  const file = join(dir, "customers.parquet");

  beforeAll(async () => {
    await writeCustomers(file, 1000);
  });

  const rowsOf = (out: string) =>
    out.split("\n").filter((l) => l.startsWith("{")).map((l) => JSON.parse(l) as Record<string, string | number>);

  it("resolves an aggregate query, and a predicate over its result columns, to the same numbers as a direct query", async () => {
    const ref = run("ref", file, "--query", BY_REGION, "--where", "total > 0").stdout.trim();
    const out = run("resolve", ref, "--root", dir);
    expect(out.status, out.stderr).toBe(0);
    const rows = rowsOf(out.stdout);

    const direct = await (await DuckDBInstance.create(":memory:")).connect();
    const expected = (
      await direct.runAndReadAll(
        `SELECT region, round(sum(amount), 2) AS total FROM '${file}' GROUP BY region ORDER BY region`,
      )
    ).getRowObjectsJson();
    expect(rows.sort((a, b) => String(a.region).localeCompare(String(b.region)))).toEqual(
      expected.map((r) => ({ region: r.region, total: Number(r.total) })),
    );
  });

  it("the Ref carries the query text and an id, and formatting does not change the id", () => {
    const a = parseRef(run("ref", file, "--query", BY_REGION).stdout.trim());
    const b = parseRef(
      run("ref", file, "--query", "select   region ,\n round(sum(amount),2) as total\nfrom data group by region").stdout.trim(),
    );
    const c = parseRef(run("ref", file, "--query", "SELECT region, sum(amount) AS total FROM data GROUP BY region").stdout.trim());
    expect(a.query).toBe(BY_REGION);
    expect(a.id).toMatch(/^[0-9a-f]{12}$/);
    expect(b.id).toBe(a.id);
    expect(c.id).not.toBe(a.id);
  });

  it("a Ref with its query text edited but its id kept is refused", () => {
    const ref = run("ref", file, "--query", BY_REGION).stdout.trim();
    const edited = ref.replace(encodeURIComponent("GROUP BY region"), encodeURIComponent("GROUP BY region HAVING count(*) > 0"));
    expect(edited).not.toBe(ref);
    const r = run("resolve", edited, "--root", dir);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("does not match");
  });

  it.each([
    ["a second statement", "SELECT 1; COPY (SELECT 1) TO '/tmp/x.csv'"],
    ["an unbalanced parenthesis", "SELECT * FROM data) UNION ALL SELECT * FROM (SELECT * FROM data"],
    ["something that is not a SELECT", "DROP TABLE data"],
  ])("minting refuses %s in the query", (_name, query) => {
    const r = run("ref", file, "--query", query);
    expect(r.status).toBe(1);
    expect(r.stdout).toBe("");
  });

  it("a query cannot read another file or a table that does not exist", () => {
    for (const query of ["SELECT * FROM read_csv('/etc/hostname')", "SELECT * FROM nope"]) {
      const r = run("ref", file, "--query", query);
      expect(r.status).toBe(1);
    }
  });

  it("a Ref without a query still resolves as before", () => {
    const ref = run("ref", file, "--where", "id <= 3").stdout.trim();
    expect(parseRef(ref).query).toBeUndefined();
    expect(rowsOf(run("resolve", ref, "--root", dir).stdout)).toHaveLength(3);
  });

  it("data changes are still detected for a Ref with a query", async () => {
    const changing = join(dir, "changing.parquet");
    await writeCustomers(changing, 1000);
    const ref = run("ref", changing, "--query", BY_REGION).stdout.trim();
    await writeCustomers(changing, 1000, 3);
    expect(run("resolve", ref, "--root", dir).stdout).toContain("DATA_CHANGED");
  });
});
