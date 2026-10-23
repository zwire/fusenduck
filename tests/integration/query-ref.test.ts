import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { DuckDBInstance } from "@duckdb/node-api";
import { formatRef, MAX_AMBIGUITY_ROWS, parseRef, selectionSql } from "@fusenduck/core";
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

describe("hand-built Refs and limits", () => {
  const dir = tempDir();
  const file = join(dir, "customers.parquet");

  beforeAll(async () => {
    await writeCustomers(file, 1000);
  });

  it("the id covers long numeric literals", () => {
    const a = parseRef(run("ref", file, "--query", "SELECT 12345678901234567890 AS x").stdout.trim());
    const b = parseRef(run("ref", file, "--query", "SELECT 12345678901234567891 AS x").stdout.trim());
    expect(a.id).not.toBe(b.id);
    const edited = run("ref", file, "--query", "SELECT 12345678901234567890 AS x").stdout.trim().replace("567890", "567891");
    const r = run("resolve", edited, "--root", dir);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("does not match");
  });

  it("resolve refuses a hand-built Ref whose query or where is hostile, with the reason", () => {
    const base = { source: file, fingerprint: "000000000000" };
    for (const [ref, reason] of [
      [formatRef({ ...base, query: "SELECT 1; DROP TABLE data" }), /query rejected/],
      [formatRef({ ...base, query: "SELECT * FROM data) UNION ALL SELECT * FROM (SELECT * FROM data" }), /query rejected/],
      [formatRef({ ...base, where: "1=1; COPY (SELECT 1) TO '/tmp/x'" }), /predicate rejected/],
    ] as const) {
      const r = run("resolve", ref, "--root", dir);
      expect(r.status).toBe(1);
      expect(r.stderr).toMatch(reason);
    }
  });

  it("a query, a predicate and columns work together", () => {
    const ref = run(
      "ref", file, "--query", "SELECT region, amount FROM data WHERE id <= 8",
      "--where", "region = 'south'", "--columns", "amount",
    ).stdout.trim();
    const rows = rowsOf2(run("resolve", ref, "--root", dir).stdout);
    expect(rows).toHaveLength(2);
    expect(Object.keys(rows[0] ?? {})).toEqual(["amount"]);
  });

  it("one very wide row cannot make the output huge, and the cut is stated", () => {
    const ref = run("ref", file, "--query", "SELECT repeat('x', 5000000) AS s").stdout.trim();
    const r = run("resolve", ref, "--root", dir);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout.length).toBeLessThan(10_000);
    expect(r.stdout).toContain("[+4998000 chars]");
    expect(r.stdout).toContain("longer than 2000 characters are cut");
  });

  it("a query that needs far more memory than the engine may hold fails without a crash", () => {
    // About 2.4 GB of integers against the 512 MB limit; it fails in the first second, where a single 900 MB string took 14.
    const ref = run("ref", file, "--query", "SELECT list(i) AS l FROM range(300000000) t(i)");
    const r = ref.status === 0 ? run("resolve", ref.stdout.trim(), "--root", dir) : ref;
    expect(r.status).toBe(1);
    expect(r.stdout).toBe("");
  });
});

describe("selecting rows of a table without a key by position", () => {
  const dir = tempDir();
  const file = join(dir, "keyless.parquet");

  beforeAll(async () => {
    await writeCustomers(file, 1000);
  });

  it("file_row_number works in a predicate, and is not a column of the result", () => {
    const ref = run("ref", file, "--where", "file_row_number BETWEEN 10 AND 12").stdout.trim();
    expect(ref).not.toBe("");
    const out = run("resolve", ref, "--root", dir);
    expect(out.status, out.stderr).toBe(0);
    const rows = rowsOf2(out.stdout);
    expect(rows.map((r) => r.id)).toEqual(["11", "12", "13"]);
    expect(Object.keys(rows[0] ?? {})).not.toContain("file_row_number");
  });

  it("a positional Ref stops resolving when the data changed", async () => {
    const changing = join(dir, "changing.parquet");
    await writeCustomers(changing, 1000);
    const ref = run("ref", changing, "--where", "file_row_number = 5").stdout.trim();
    await writeCustomers(changing, 1000, 3);
    const r = run("resolve", ref, "--root", dir);
    expect(r.stdout).toContain("DATA_CHANGED");
    expect(r.stdout).not.toContain('"id"');
  });

  it("a file with its own file_row_number column keeps using that column", async () => {
    const own = join(dir, "own.parquet");
    const connection = await (await DuckDBInstance.create(":memory:")).connect();
    await connection.run(`COPY (SELECT i AS id, i * 10 AS file_row_number FROM range(5) t(i)) TO '${own}' (FORMAT parquet)`);
    const ref = run("ref", own, "--where", "file_row_number = 30", "--columns", "id,file_row_number").stdout.trim();
    expect(ref).not.toBe("");
    const out = run("resolve", ref, "--root", dir);
    expect(out.status, out.stderr).toBe(0);
    expect(rowsOf2(out.stdout)).toEqual([{ id: "3", file_row_number: "30" }]);
  });

  it("positions combine with --columns", () => {
    const ref = run("ref", file, "--where", "file_row_number BETWEEN 2 AND 3", "--columns", "id,region").stdout.trim();
    const rows = rowsOf2(run("resolve", ref, "--root", dir).stdout);
    expect(rows.map((r) => r.id)).toEqual(["3", "4"]);
    expect(Object.keys(rows[0] ?? {})).toEqual(["id", "region"]);
  });

  it("a Ref that does not mention it is selected exactly as before", () => {
    expect(selectionSql({ source: "/d/a.parquet", where: "id = 1", fingerprint: "x" })).toBe(
      "SELECT * FROM (SELECT * FROM read_parquet('/d/a.parquet')) WHERE (\nid = 1\n)",
    );
  });
});

const rowsOf2 = (out: string) =>
  out.split("\n").filter((l) => l.startsWith("{")).map((l) => JSON.parse(l) as Record<string, unknown>);

describe("a selection that matches identical rows", () => {
  const dir = tempDir();
  const file = join(dir, "dupes.parquet");

  beforeAll(async () => {
    // 30 rows, no key: each (k, flag) pair appears 5 times as identical rows.
    const connection = await (await DuckDBInstance.create(":memory:")).connect();
    await connection.run(
      `COPY (SELECT ['a','b','c'][1 + (i % 3)] AS k, i % 2 AS flag FROM range(30) t(i)) TO '${file}' (FORMAT parquet)`,
    );
  });

  it("returns the rows and says they are ambiguous, with the way to pick one", () => {
    const ref = run("ref", file, "--where", "k = 'a' AND flag = 1").stdout.trim();
    const out = run("resolve", ref, "--root", dir);
    expect(out.status, out.stderr).toBe(0);
    expect(rowsOf2(out.stdout)).toHaveLength(5);
    expect(out.stdout).toContain('level="rows" distinct="1"');
    expect(out.stdout).toContain("AMBIGUOUS: the 5 matching rows hold only 1 distinct row (4 are identical copies)");
    expect(out.stdout).toContain("file_row_number");
  });

  it("a Ref by position picks one copy and is not ambiguous", () => {
    const ref = run("ref", file, "--where", "file_row_number = 3").stdout.trim();
    const out = run("resolve", ref, "--root", dir);
    expect(rowsOf2(out.stdout)).toEqual([{ k: "a", flag: "1" }]);
    expect(out.stdout).not.toContain("AMBIGUOUS");
    expect(out.stdout).not.toContain("distinct=");
  });

  it("counts copies over every matching row, not only the ones shown", () => {
    const ref = run("ref", file, "--where", "k = 'b'").stdout.trim();
    const out = run("resolve", ref, "--root", dir, "--limit", "1").stdout;
    expect(out).toContain("OMITTED: 9 of 10 rows are not shown");
    expect(out).toContain("AMBIGUOUS: the 10 matching rows hold only 2 distinct rows (8 are identical copies)");
  });

  it("counts copies of the columns the Ref selects", () => {
    const ref = run("ref", file, "--where", "flag = 0", "--columns", "flag").stdout.trim();
    expect(run("resolve", ref, "--root", dir).stdout).toContain("only 1 distinct row (14 are identical copies in the selected columns)");
  });

  it("the rows of a query are checked too, without a position to offer", () => {
    const ref = run("ref", file, "--query", "SELECT k FROM data", "--where", "k = 'c'").stdout.trim();
    const out = run("resolve", ref, "--root", dir).stdout;
    expect(out).toContain("AMBIGUOUS: the 10 matching rows hold only 1 distinct row");
    expect(out).toContain("Rows of a query have no position");
  });

  const write = async (name: string, select: string) => {
    const path = join(dir, name);
    const connection = await (await DuckDBInstance.create(":memory:")).connect();
    await connection.run(`COPY (${select}) TO '${path}' (FORMAT parquet)`);
    return path;
  };
  const resolveWhere = (path: string, ...args: string[]) => run("resolve", run("ref", path, ...args).stdout.trim(), "--root", dir, "--limit", "3");

  it("a column named like a row alias does not change the count", async () => {
    const differ = await write("s-differ.parquet", "SELECT 1 AS s, i AS x FROM range(5) t(i)");
    expect(resolveWhere(differ, "--where", "s = 1").stdout).not.toContain("AMBIGUOUS");
    const nulls = await write("s-null.parquet", "SELECT NULL::INT AS s, 1 AS x FROM range(5) t(i)");
    expect(resolveWhere(nulls, "--where", "x = 1").stdout).toContain("only 1 distinct row (4 are identical copies)");
  });

  it("a count that fails leaves the result as it was before", async () => {
    const late = await write("late.parquet", "SELECT CASE WHEN i < 150 THEN i::VARCHAR ELSE 'x' END AS v FROM range(200) t(i)");
    const out = run("resolve", run("ref", late, "--query", "SELECT v::INT AS n FROM data").stdout.trim(), "--root", dir, "--limit", "3");
    expect(out.status, out.stderr).toBe(0);
    expect(out.stdout).toContain("OMITTED: 197 of 200 rows are not shown");
    expect(out.stdout).not.toContain("AMBIGUOUS");
  });

  it("a file with its own file_row_number column is not offered positions", async () => {
    const own = await write("own-frn.parquet", "SELECT 7 AS file_row_number, 'a' AS k FROM range(3)");
    const out = resolveWhere(own, "--where", "k = 'a'").stdout;
    expect(out).toContain("AMBIGUOUS: the 3 matching rows hold only 1 distinct row");
    expect(out).toContain("Add columns that tell them apart.");
    expect(out).not.toContain("positions count from 0");
  });

  it("a Ref that selects by position is not called ambiguous", () => {
    expect(resolveWhere(file, "--where", "file_row_number IN (0, 6)").stdout).not.toContain("AMBIGUOUS");
  });

  it("selections over MAX_AMBIGUITY_ROWS are not counted", async () => {
    const many = await write("many.parquet", `SELECT 1 AS k FROM range(${MAX_AMBIGUITY_ROWS + 1})`);
    expect(resolveWhere(many).stdout).not.toContain("AMBIGUOUS");
    const edge = await write("edge.parquet", `SELECT 1 AS k FROM range(${MAX_AMBIGUITY_ROWS})`);
    expect(resolveWhere(edge).stdout).toContain(`AMBIGUOUS: the ${MAX_AMBIGUITY_ROWS} matching rows`);
  });
});
