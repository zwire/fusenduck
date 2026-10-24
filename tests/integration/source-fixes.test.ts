import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { DuckDBInstance } from "@duckdb/node-api";
import { describe, expect, it } from "vitest";
import { buildCard, fingerprint, mintRefWith, openSource, resolveRef } from "@fusenduck/core";
import { tempDir } from "../helpers/fixtures.ts";

const ids = (out: string) => out.split("\n").filter((l) => l.startsWith("{")).map((l) => Number((JSON.parse(l) as { id: string }).id));

describe("review findings on text and database sources (#43)", () => {
  it("opens a DuckDB table that is itself named data", async () => {
    const dir = tempDir();
    const file = join(dir, "d.duckdb");
    const instance = await DuckDBInstance.create(file);
    const connection = await instance.connect();
    await connection.run("CREATE TABLE data(id BIGINT, v VARCHAR); INSERT INTO data SELECT i, 'v' || i FROM range(4) t(i)");
    await connection.run("CHECKPOINT");
    connection.closeSync();
    instance.closeSync();
    const engine = await openSource(`${file}#data`, { roots: [dir] });
    try {
      expect((await buildCard(engine)).rows).toBe(4);
      const before = await fingerprint(engine);
      const ref = await mintRefWith(engine, { where: "id >= 2", expect: before });
      expect(ids(await resolveRef(ref, { roots: [dir] }))).toEqual([2, 3]);
    } finally {
      engine.close();
    }
  });

  it("refuses CSV files whose columns differ in order or name, instead of mapping them by position", async () => {
    const dir = tempDir();
    writeFileSync(join(dir, "o1.csv"), "id,n\n1,2\n");
    writeFileSync(join(dir, "o2.csv"), "n,id\n7,8\n");
    await expect(openSource(join(dir, "o*.csv"), { roots: [dir] })).rejects.toThrow(/same columns/);
  });

  it("detects a pattern's layout from the files that have content, not from an empty first file", async () => {
    const dir = tempDir();
    writeFileSync(join(dir, "e1.csv"), "");
    writeFileSync(join(dir, "e2.csv"), "id,n\n1,2\n3,4\n");
    const engine = await openSource(join(dir, "e*.csv"), { roots: [dir] });
    try {
      expect((await buildCard(engine)).rows).toBe(2);
    } finally {
      engine.close();
    }
  });

  it("refuses a column name longer than 256 characters in a text file", async () => {
    const dir = tempDir();
    writeFileSync(join(dir, "w.csv"), `${"x".repeat(300)},b\n1,2\n`);
    await expect(openSource(join(dir, "w.csv"), { roots: [dir] })).rejects.toThrow(/column name/);
    writeFileSync(join(dir, "w.ndjson"), `{"${"y".repeat(300)}":1}\n`);
    await expect(openSource(join(dir, "w.ndjson"), { roots: [dir] })).rejects.toThrow(/column name/);
  });

  it("sees a column that only a later NDJSON file has", async () => {
    const dir = tempDir();
    writeFileSync(join(dir, "n1.ndjson"), '{"id":1}\n');
    writeFileSync(join(dir, "n2.ndjson"), '{"id":2,"extra":"x"}\n');
    const engine = await openSource(join(dir, "n*.ndjson"), { roots: [dir] });
    try {
      expect((await buildCard(engine)).columns.map((c) => c.column)).toContain("extra");
    } finally {
      engine.close();
    }
  });
});
