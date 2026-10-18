import { join } from "node:path";
import { existsSync } from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";
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
});
