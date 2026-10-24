import { copyFileSync, existsSync, readdirSync, truncateSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { ManyTables, openSource, parseRef, setExtensionDirectory } from "@fusenduck/core";
import { extensionDirectory } from "../../packages/core/src/extensions.ts";
import { tempDir } from "../helpers/fixtures.ts";
import { writeSqlite } from "../helpers/sqlite.ts";

const cli = join(import.meta.dirname, "../../packages/cli/src/index.ts");
const run = (...args: string[]) => spawnSync("node", [cli, ...args], { encoding: "utf8" });
const failure = (work: Promise<unknown>): Promise<Error> =>
  work.then(() => { throw new Error("it did not fail"); }, (e: unknown) => e as Error);
const refOf = (out: string) => out.trim().split("\n").pop()!;

describe("a SQLite file", () => {
  const dir = tempDir();
  const many = join(dir, "many.sqlite");
  const one = join(dir, "one.sqlite3");

  beforeAll(() => {
    writeSqlite(many);
    writeSqlite(one, { extra: (db) => db.exec("DROP TABLE other") });
  });

  it("opens the only table of a database by itself", () => {
    const out = run("card", one);
    expect(out.stderr).toBe("");
    expect(out.status).toBe(0);
    expect(out.stdout).toContain("rows: 5");
  });

  it("asks which table when there are several, and opens it as file#table", () => {
    const asked = run("card", many);
    expect(asked.status).not.toBe(0);
    expect(asked.stderr).toContain("other, people");
    expect(asked.stderr).toContain("file.sqlite#table");
    const out = run("card", `${many}#people`);
    expect(out.status).toBe(0);
    expect(out.stdout).toContain('"column":"name"');
  });

  it("lists the tables as data of the error", async () => {
    const error = await openSource(many).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ManyTables);
    expect((error as ManyTables).tables).toEqual(["other", "people"]);
  });

  it("mints a Ref with the kind and the table, and resolves it by a column", () => {
    const ref = refOf(run("ref", `${many}#people`, "--where", "id = 2").stdout);
    const parsed = parseRef(ref);
    expect(parsed.src).toBe("sqlite");
    expect(parsed.options).toEqual({ table: "people" });
    const out = run("resolve", ref, "--root", dir);
    expect(out.stdout).toContain('"id":"2","name":"ünï"');
    expect(out.stdout).toContain("All 1 matching rows");
  });

  it("finds the table whatever the case of its name, and keeps the file's spelling", async () => {
    const engine = await openSource(`${many}#PEOPLE`);
    try {
      expect(engine.adapter.options).toEqual({ table: "people" });
    } finally {
      engine.close();
    }
  });

  it("reads NULL, REAL, BLOB and unicode values", async () => {
    const engine = await openSource(`${many}#people`);
    try {
      const rows = await engine.query("SELECT * FROM data ORDER BY id");
      expect(rows[0]).toEqual({ id: "0", name: "n0", score: 0.5, photo: "\\x00\\xFF", born: "2020-01-01" });
      expect(rows[1]).toEqual({ id: "1", name: "n1", score: null, photo: null, born: null });
      expect(rows[2]?.name).toBe("ünï");
    } finally {
      engine.close();
    }
  });

  it("reads a view, an empty table and a table named data", async () => {
    const file = join(dir, "shapes.sqlite");
    writeSqlite(file, {
      extra: (db) => db.exec("CREATE VIEW adults AS SELECT id, name FROM people WHERE id > 2; CREATE TABLE empty(a INTEGER); CREATE TABLE data(x INTEGER); INSERT INTO data VALUES (7)"),
    });
    for (const [table, count] of [["adults", "2"], ["empty", "0"], ["data", "1"]] as const) {
      const engine = await openSource(`${file}#${table}`);
      try {
        expect((await engine.query("SELECT count(*) AS n FROM data"))[0]?.n).toBe(count);
      } finally {
        engine.close();
      }
    }
  });

  it("reads a table with an unusual name, and a wide table", async () => {
    const file = join(dir, "odd.sqlite");
    const columns = Array.from({ length: 300 }, (_, i) => `c${i} INTEGER`).join(", ");
    writeSqlite(file, { extra: (db) => db.exec(`CREATE TABLE "we ird'name"(a INTEGER); INSERT INTO "we ird'name" VALUES (1); CREATE TABLE "q""t"(a INTEGER); CREATE TABLE wide(${columns})`) });
    const engine = await openSource(file, { options: { table: "we ird'name" }, kind: "sqlite" });
    expect((await engine.query("SELECT a FROM data"))[0]?.a).toBe("1");
    engine.close();
    // The same limit as for a DuckDB file.
    await expect(openSource(file, { options: { table: 'q"t' }, kind: "sqlite" })).rejects.toThrow(/double quote/);
    const wide = await openSource(`${file}#wide`);
    expect((await wide.query("DESCRIBE data")).length).toBe(300);
    wide.close();
  });

  it("reads the rows of a database in WAL mode that are still in its log", async () => {
    const live = join(dir, "live.sqlite");
    const db = new DatabaseSync(live);
    db.exec("PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; CREATE TABLE t(a INTEGER)");
    db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    db.exec("INSERT INTO t VALUES (1), (2), (3)");
    expect(existsSync(`${live}-wal`)).toBe(true);
    // The main file alone has no rows: they are in the log.
    const snapshot = join(dir, "snapshot.sqlite");
    copyFileSync(live, snapshot);
    const plain = await openSource(`${snapshot}#t`);
    expect((await plain.query("SELECT count(*) AS n FROM data"))[0]?.n).toBe("0");
    plain.close();
    const engine = await openSource(`${live}#t`);
    try {
      expect((await engine.query("SELECT count(*) AS n FROM data"))[0]?.n).toBe("3");
    } finally {
      engine.close();
      db.close();
    }
  });

  it("says the data changed after a row is added, and not after another table changes", () => {
    const file = join(dir, "changing.sqlite");
    writeSqlite(file);
    const ref = refOf(run("ref", `${file}#people`, "--where", "id = 1").stdout);
    const edit = (sql: string) => {
      const db = new DatabaseSync(file);
      db.exec(sql);
      db.close();
    };
    expect(run("resolve", ref, "--root", dir).stdout).toContain('"id":"1"');
    edit("INSERT INTO other VALUES ('more')");
    expect(run("resolve", ref, "--root", dir).stdout).toContain('"id":"1"');
    edit("INSERT INTO people VALUES (9, 'new', 1.0, NULL, NULL)");
    const changed = run("resolve", ref, "--root", dir);
    expect(changed.stdout + changed.stderr).toMatch(/changed/i);
  });

  it("refuses a file that is not a SQLite database, with fixed wording", async () => {
    const file = join(dir, "text.sqlite");
    writeFileSync(file, "this is not a database, it says SECRET-TEXT\n".repeat(50));
    const error = await failure(openSource(file));
    expect(error.message).toBe("this file is not a readable SQLite database");
  });

  it("refuses a file over the size it copies, before reading it", async () => {
    const file = join(dir, "big.sqlite");
    writeFileSync(file, "");
    truncateSync(file, 600_000_000);
    const error = await failure(openSource(file));
    expect(error.message).toMatch(/copies at most 536 MB/);
  });

  it("opens a pattern or a missing file with the same errors as other sources", async () => {
    await expect(openSource(join(dir, "*.sqlite"))).rejects.toThrow(/opened alone/);
    await expect(openSource(join(dir, "gone.sqlite"))).rejects.toThrow(/no such file/);
  });

  it("leaves nothing in the temporary folder once the engine is closed, or when opening fails", async () => {
    const before = readdirSync(join(dir, "..")).filter((n) => n.startsWith("fusenduck-sqlite-"));
    const engine = await openSource(`${many}#people`);
    const during = readdirSync(join(dir, "..")).filter((n) => n.startsWith("fusenduck-sqlite-"));
    expect(during.length).toBe(before.length + 1);
    engine.close();
    await openSource(`${many}#nothere`).catch(() => undefined);
    await openSource(many).catch(() => undefined);
    expect(readdirSync(join(dir, "..")).filter((n) => n.startsWith("fusenduck-sqlite-"))).toEqual(before);
  });

  describe("without the shipped extension", () => {
    const original = extensionDirectory();
    afterEach(() => setExtensionDirectory(original));

    it("says how to get it, and does not download it", async () => {
      setExtensionDirectory(join(dir, "no-extensions"));
      const error = await failure(openSource(`${many}#people`));
      expect(error.message).toContain("pnpm extensions:fetch");
    });
  });
});
