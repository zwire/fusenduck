import { join } from "node:path";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { openSource, checkPredicate, fingerprint, formatRef, mintRef, resolveRef, CostExceeded } from "@fusenduck/core";
import { tempDir, writeCustomers } from "../helpers/fixtures.ts";

describe("read-only by construction (the engine, not SQL text)", () => {
  const dir = tempDir();
  const file = join(dir, "customers.parquet");
  const other = join(dir, "other.parquet");

  beforeAll(async () => {
    await writeCustomers(file, 100);
    await writeCustomers(other, 100);
  });

  it("reads the opened file", async () => {
    const engine = await openSource(file);
    const rows = await engine.query(`SELECT count(*) AS n FROM read_parquet('${file}')`);
    expect(rows[0]?.n).toBe("100");
  });

  it.each([
    ["reading another file", (f: string) => `SELECT * FROM read_parquet('${f.replace("customers", "other")}')`],
    ["reading a system file", () => `SELECT * FROM read_csv('/etc/hostname')`],
    ["COPY TO a new file", (f: string) => `COPY (SELECT 1) TO '${f}.out.csv'`],
    ["COPY TO a sibling of the opened file", (f: string) => `COPY (SELECT 1 x) TO '${f}.copy' (FORMAT parquet)`],
    ["overwriting the opened file", (f: string) => `COPY (SELECT 1 x) TO '${f}' (FORMAT parquet)`],
    ["ATTACH a new database file", (f: string) => `ATTACH '${f}.db'`],
    ["unlocking the configuration", () => `SET enable_external_access=true`],
    ["widening the allow-list", (f: string) => `SET allowed_paths=['${f}','/etc/hostname']`],
  ])("rejects %s", async (_name, sql) => {
    const engine = await openSource(file);
    await expect(engine.query(sql(file))).rejects.toThrow();
    expect(existsSync(`${file}.out.csv`)).toBe(false);
    expect(existsSync(`${file}.copy`)).toBe(false);
    expect(existsSync(`${file}.db`)).toBe(false);
    const rows = await engine.query(`SELECT count(*) AS n FROM read_parquet('${file}')`);
    expect(rows[0]?.n).toBe("100");
  });

  it.each([
    ["a second statement", "1=1; COPY (SELECT 1) TO '/tmp/x.csv'"],
    ["a DROP", "id IN (SELECT 1); DROP TABLE t"],
    ["an unbalanced parenthesis", "1=1) UNION ALL SELECT 1 FROM (SELECT 1"],
    ["a UNION that turns the query into a set operation", "1=1 UNION ALL SELECT 1, 'a', 2.0, 'b', 'c'"],
  ])("checkPredicate rejects %s before the engine runs it", async (_name, predicate) => {
    const engine = await openSource(file);
    await expect(checkPredicate(engine, file, predicate)).rejects.toThrow();
  });

  it("checkPredicate accepts an ordinary predicate", async () => {
    const engine = await openSource(file);
    await expect(checkPredicate(engine, file, "region = 'south' AND amount > 10")).resolves.toBeUndefined();
  });

  it("the cost guard stops a selection that would scan more than the limit, before reading rows", async () => {
    const ref = await mintRef(file, { where: "id <= 5" });
    await expect(resolveRef(ref, { maxBytes: 1, roots: [dir] })).rejects.toBeInstanceOf(CostExceeded);
    await expect(resolveRef(ref, { roots: [dir] })).resolves.toContain("FUSEN_DATA_BEGIN");
  });

  it("a slow predicate is stopped by the clock", async () => {
    const slow = "id IN (SELECT i FROM range(3000000000) t(i) WHERE i % 7 = -1)";
    const ref = formatRef({ source: file, where: slow, fingerprint: await fingerprint(await openSource(file)) });
    const started = Date.now();
    await expect(resolveRef(ref, { timeoutMs: 300, roots: [dir] })).rejects.toThrow(/stopped after 300 ms/);
    expect(Date.now() - started).toBeLessThan(5000);
  });

  it("a Ref that points outside the allowed roots is refused, even with a matching fingerprint", async () => {
    const ref = await mintRef(file, { where: "id <= 5" });
    const elsewhere = tempDir();
    await expect(resolveRef(ref, { roots: [elsewhere] })).rejects.toThrow(/outside the allowed roots/);
  });

  it.each([
    ["a LIMIT", "id < 5 LIMIT 2"],
    ["an OFFSET", "id = 1 OFFSET 1"],
    ["an ORDER BY", "id < 5 ORDER BY id"],
  ])("checkPredicate rejects %s that would change the shape of the query", async (_name, predicate) => {
    const engine = await openSource(file);
    await expect(checkPredicate(engine, file, predicate)).rejects.toThrow();
  });

  it("a trailing -- comment in a predicate is contained and the Ref still resolves", async () => {
    const ref = await mintRef(file, { where: "id = 1 -- only the first" });
    const out = await resolveRef(ref, { roots: [dir] });
    expect(out).toContain('"id":"1"');
    expect(out).toContain("All 1 matching rows are shown");
  });

  it("minting a Ref fails now for a column that does not exist", async () => {
    await expect(mintRef(file, { columns: ["nope"] })).rejects.toThrow();
  });

  // A pasted Ref carries its own query, and the result is materialized before rendering cuts it.
  it("a query of huge cells does not materialize them: rows past the fetch budget are left out and said so", async () => {
    const huge = await mintRef(file, { query: "SELECT id, repeat('x', 3000000) AS s FROM data", roots: [dir] });
    const started = Date.now();
    const out = await resolveRef(huge, { limit: 1000, roots: [dir] });
    expect(Date.now() - started).toBeLessThan(10_000);
    const shown = out.split("\n").filter((l) => l.startsWith("{"));
    expect(shown.length).toBeGreaterThan(0);
    expect(shown.length).toBeLessThan(100);
    expect(out).toContain(`of 100 rows are not shown`);
    expect(out).toMatch(/rows past \d+ bytes are not read/);
  });

  it("a single row over the fetch budget is not read at all, and the result says so", async () => {
    const one = await mintRef(file, { query: "SELECT repeat('x', 40000000) AS s FROM data LIMIT 1", roots: [dir] });
    const out = await resolveRef(one, { roots: [dir] });
    expect(out.split("\n").filter((l) => l.startsWith("{"))).toHaveLength(0);
    expect(out).toContain("OMITTED: 1 of 1 rows are not shown");
    expect(out).toMatch(/rows past \d+ bytes are not read/);
  });

  it("a cell under the fetch budget is still shown cut, as before", async () => {
    const big = await mintRef(file, { query: "SELECT repeat('x', 100000) AS s FROM data LIMIT 3", roots: [dir] });
    const out = await resolveRef(big, { roots: [dir] });
    expect(out).toContain("All 3 matching rows are shown");
    expect(out).toContain("[+98000 chars]");
  });

  // DuckDB adds its spill directory (default: .tmp under the working directory) to the directories
  // it may read and write even with external access off, so the lock must turn spilling off.
  describe("the engine's temp directory", () => {
    const tmp = join(process.cwd(), ".tmp");
    const made = !existsSync(tmp);
    const planted = join(tmp, "planted.csv");

    beforeAll(() => {
      mkdirSync(tmp, { recursive: true });
      writeFileSync(planted, "secret\nPLANTED-4417\n");
    });
    afterAll(() => {
      if (made) rmSync(tmp, { recursive: true, force: true });
      else rmSync(planted, { force: true });
    });

    it("is not on the engine's allow-list", async () => {
      const engine = await openSource(file);
      const rows = await engine.query("SELECT current_setting('allowed_directories')::VARCHAR AS d");
      expect(rows[0]?.d).toBe("[]");
    });

    it.each([
      ["reading a file in it", () => `SELECT * FROM read_text('${planted}')`],
      ["listing it", () => `SELECT * FROM glob('${tmp}/*')`],
      ["COPY TO it", () => `COPY (SELECT 1 AS x) TO '${join(tmp, "written.csv")}'`],
      ["ATTACH a database file in it", () => `ATTACH '${join(tmp, "written.db")}' AS w`],
    ])("rejects %s", async (_name, sql) => {
      const engine = await openSource(file);
      await expect(engine.query(sql())).rejects.toThrow(/Permission Error/);
      expect(existsSync(join(tmp, "written.csv"))).toBe(false);
      expect(existsSync(join(tmp, "written.db"))).toBe(false);
    });

    it("a Ref whose query reads it is refused", async () => {
      const ref = mintRef(file, { query: `SELECT * FROM read_text('${planted}')`, roots: [dir] });
      await expect(ref).rejects.toThrow();
    });
  });
});
