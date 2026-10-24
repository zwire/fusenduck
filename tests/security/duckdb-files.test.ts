import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { openSource } from "@fusenduck/core";
import { tempDir } from "../helpers/fixtures.ts";
import { writeDatabase } from "../helpers/duckdb.ts";

const digest = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex");

// The file is the engine's own database, opened read-only. Whatever is run on the engine, the file stays as it was.
describe("a DuckDB database file cannot be written, detached or attached again", () => {
  const dir = tempDir();
  const file = join(dir, "db.duckdb");
  let before: string;

  beforeAll(async () => {
    await writeDatabase(file);
    before = digest(file);
  });

  it.each([
    ["INSERT", "INSERT INTO people VALUES (99, 'evil')"],
    ["CREATE TABLE", "CREATE TABLE z(a INT)"],
    ["DROP TABLE", "DROP TABLE other"],
    ["UPDATE", "UPDATE people SET name = 'x'"],
    ["CHECKPOINT", "CHECKPOINT"],
    ["attaching the file again", `ATTACH '${file}' AS w`],
    ["attaching the file read-write", `ATTACH '${file}' AS w (READ_WRITE)`],
    ["attaching another database file", `ATTACH '${join(dir, "other.duckdb")}' AS o`],
    ["attaching memory", "ATTACH ':memory:' AS m"],
    ["detaching the database", "DETACH DATABASE db"],
    ["leaving the database to detach it", "USE system"],
    ["COPY TO a file", `COPY people TO '${join(dir, "out.csv")}'`],
    ["COPY FROM DATABASE", "COPY FROM DATABASE db TO db"],
    ["unlocking the configuration", "SET enable_external_access=true"],
    ["making it writable", "SET access_mode='READ_WRITE'"],
    ["reading a system file", "SELECT * FROM read_csv('/etc/hostname')"],
  ])("rejects %s", async (_what, sql) => {
    const engine = await openSource(`${file}#people`);
    try {
      // A statement that is refused, or one that is allowed to do nothing, must leave the file as it was.
      await engine.query(sql).catch(() => undefined);
      expect((await engine.query("SELECT count(*) AS n FROM data"))[0]?.n).toBe("5");
    } finally {
      engine.close();
    }
    expect(digest(file)).toBe(before);
    expect(existsSync(join(dir, "out.csv"))).toBe(false);
    expect(existsSync(`${file}.wal`)).toBe(false);
  });

  it("a chain that detaches and re-attaches read-write cannot get past the read-only database", async () => {
    const engine = await openSource(`${file}#people`);
    try {
      for (const sql of [`ATTACH '${file}' AS w`, "USE w", "DETACH db", "USE system", "DETACH w", `ATTACH '${file}' AS x (READ_WRITE)`, "INSERT INTO x.main.people VALUES (99, 'evil')"]) {
        await engine.query(sql).catch(() => undefined);
      }
    } finally {
      engine.close();
    }
    expect(digest(file)).toBe(before);
  });

  it("a query can read the other tables of the file: the boundary is the file, not the table", async () => {
    const engine = await openSource(`${file}#people`);
    try {
      expect((await engine.query("SELECT secret FROM other"))[0]?.secret).toBe("SECRET");
    } finally {
      engine.close();
    }
  });
});
