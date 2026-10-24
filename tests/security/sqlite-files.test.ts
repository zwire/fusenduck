import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { beforeAll, describe, expect, it } from "vitest";
import { DuckDBInstance } from "@duckdb/node-api";
import { openSource, setExtensionDirectory } from "@fusenduck/core";
import { bundledExtension, extensionDirectory, lockedExtension } from "../../packages/core/src/extensions.ts";
import { tempDir } from "../helpers/fixtures.ts";
import { writeSqlite } from "../helpers/sqlite.ts";

const failure = (work: Promise<unknown>): Promise<Error> =>
  work.then(() => { throw new Error("it did not fail"); }, (e: unknown) => e as Error);
const digest = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex");

// The SQLite extension opens files with SQLite's own file access, which the engine's allow list and external-access switch do
// not govern. So the engine that runs a query never has it loaded: the table is copied by a throwaway engine first.
describe("a SQLite file cannot be written, attached or used to reach another file", () => {
  const dir = tempDir();
  const file = join(dir, "db.sqlite");
  const other = join(dir, "other.sqlite");
  let before: string;
  let otherBefore: string;
  let extension: string;

  beforeAll(async () => {
    // The real shipped file of this machine: loading it by path must be refused in the query engine too.
    const instance = await DuckDBInstance.create(":memory:");
    const row = (await (await instance.connect()).runAndReadAll("SELECT version() AS v, platform AS p FROM pragma_platform()")).getRowObjectsJson()[0]!;
    instance.closeSync();
    extension = bundledExtension("sqlite_scanner", String(row.v), String(row.p));
    writeSqlite(file);
    writeSqlite(other);
    before = digest(file);
    otherBefore = digest(other);
  });

  it.each([
    ["INSERT", "INSERT INTO people VALUES (99, 'evil', 1.0, NULL, NULL)"],
    ["CREATE TABLE", "CREATE TABLE z(a INT)"],
    ["DROP TABLE", "DROP TABLE other"],
    ["UPDATE", "UPDATE people SET name = 'x'"],
    ["COPY TO a file", `COPY people TO '${join(dir, "out.csv")}'`],
    ["unlocking the configuration", "SET enable_external_access=true"],
    ["making it writable", "SET access_mode='READ_WRITE'"],
    ["reading a system file", "SELECT * FROM read_csv('/etc/hostname')"],
    // The extension's own entry points: none of them exists in the engine that runs the query.
    ["sqlite_scan of the source", `SELECT * FROM sqlite_scan('${file}', 'other')`],
    ["sqlite_scan of another SQLite file", `SELECT * FROM sqlite_scan('${other}', 'other')`],
    ["sqlite_scan of any file", "SELECT * FROM sqlite_scan('/etc/passwd', 'x')"],
    ["sqlite_attach", `CALL sqlite_attach('${other}')`],
    ["sqlite_query", `SELECT * FROM sqlite_query('${other}', 'DELETE FROM other')`],
    ["attaching the source as SQLite", `ATTACH '${file}' AS w (TYPE sqlite)`],
    ["attaching another SQLite file", `ATTACH '${other}' AS w (TYPE sqlite)`],
    ["attaching the source read-write", `ATTACH '${file}' AS w (TYPE sqlite, READ_WRITE)`],
    ["attaching a new SQLite file", `ATTACH '${join(dir, "new.sqlite")}' AS w (TYPE sqlite)`],
    ["loading the extension by name", "LOAD sqlite_scanner"],
    ["installing an extension", "INSTALL httpfs"],
    ["loading a file as an extension", "LOAD EXTENSION_FILE"],
  ])("rejects %s", async (_what, text) => {
    const sql = text.replace("EXTENSION_FILE", `'${extension.replaceAll("'", "''")}'`);
    const engine = await openSource(`${file}#people`);
    try {
      await expect(engine.query(sql)).rejects.toThrow();
      expect((await engine.query("SELECT count(*) AS n FROM data"))[0]?.n).toBe("5");
    } finally {
      engine.close();
    }
    expect(digest(file)).toBe(before);
    expect(digest(other)).toBe(otherBefore);
    expect(readdirSync(dir).sort()).toEqual(["db.sqlite", "other.sqlite"]);
  });

  it("does not name the extension's functions at all in the engine that runs a query", async () => {
    const engine = await openSource(`${file}#people`);
    try {
      const names = await engine.query("SELECT function_name FROM duckdb_functions() WHERE function_name LIKE 'sqlite%'");
      expect(names).toEqual([]);
    } finally {
      engine.close();
    }
  });

  it("leaves the source and the folder it is in as they were, for a database in WAL mode too", async () => {
    const wal = join(dir, "wal.sqlite");
    writeSqlite(wal, { wal: true });
    const walBefore = digest(wal);
    const names = readdirSync(dir).sort();
    const engine = await openSource(`${wal}#people`);
    try {
      expect((await engine.query("SELECT count(*) AS n FROM data"))[0]?.n).toBe("5");
    } finally {
      engine.close();
    }
    expect(digest(wal)).toBe(walBefore);
    expect(readdirSync(dir).sort()).toEqual(names);
  });

  it("does not follow a -wal link out of the folder, or wait on a -wal pipe", async () => {
    const linked = join(dir, "linked.sqlite");
    writeSqlite(linked);
    const secret = join(dir, "..", `secret-${Date.now()}.sqlite-wal`);
    writeFileSync(secret, "SECRET-FRAMES");
    symlinkSync(secret, `${linked}-wal`);
    const engine = await openSource(`${linked}#people`);
    try {
      expect((await engine.query("SELECT count(*) AS n FROM data"))[0]?.n).toBe("5");
    } finally {
      engine.close();
    }
    if (process.platform !== "win32") {
      const piped = join(dir, "piped.sqlite");
      writeSqlite(piped);
      expect(spawnSync("mkfifo", [`${piped}-wal`]).status).toBe(0);
      const again = await openSource(`${piped}#people`);
      try {
        expect((await again.query("SELECT count(*) AS n FROM data"))[0]?.n).toBe("5");
      } finally {
        again.close();
      }
    }
  });

  it("refuses a source that is a pipe, as it does for other files", async () => {
    if (process.platform === "win32") return;
    const pipe = join(dir, "pipe.sqlite");
    expect(spawnSync("mkfifo", [pipe]).status).toBe(0);
    await expect(openSource(pipe)).rejects.toThrow(/no such file|not readable/);
  });

  it("keeps the copy in a folder only its owner can enter, which is gone when the engine is closed", async () => {
    const engine = await openSource(`${file}#people`);
    const folders = readdirSync(tmpdir()).filter((n) => n.startsWith("fusenduck-sqlite-"));
    expect(folders.length).toBeGreaterThan(0);
    // The folders of other tests' engines may be here too; each is private.
    if (process.platform !== "win32") for (const name of folders) expect(statSync(join(tmpdir(), name)).mode & 0o077).toBe(0);
    engine.close();
  });
});

// The shipped extension is native code. Only the file that matches its pin is loaded.
describe("the SQLite extension is the shipped, pinned file", () => {
  const original = extensionDirectory();
  const dir = tempDir();

  it("has a pin for every platform DuckDB publishes it for, with hashes", () => {
    for (const platform of ["linux_amd64", "linux_arm64", "linux_amd64_musl", "linux_arm64_musl", "osx_amd64", "osx_arm64", "windows_amd64", "windows_arm64"]) {
      const pin = lockedExtension("sqlite_scanner", "v1.5.6", platform);
      expect(pin?.url).toBe(`https://extensions.duckdb.org/v1.5.6/${platform}/sqlite_scanner.duckdb_extension.gz`);
      expect(pin?.gz).toMatch(/^[0-9a-f]{64}$/);
      expect(pin?.sha256).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  it("is not loaded when the file differs from its pin, and the source is not read", async () => {
    const planted = join(dir, "planted");
    for (const platform of ["linux_amd64", "linux_amd64_musl", "linux_arm64", "linux_arm64_musl", "osx_amd64", "osx_arm64", "windows_amd64", "windows_arm64"]) {
      mkdirSync(join(planted, "v1.5.6", platform), { recursive: true });
      writeFileSync(join(planted, "v1.5.6", platform, "sqlite_scanner.duckdb_extension"), "not the extension");
    }
    const source = join(dir, "x.sqlite");
    writeSqlite(source);
    setExtensionDirectory(planted);
    try {
      const error = await failure(openSource(`${source}#people`));
      expect(error.message).toContain("does not match the hash");
      expect(error.message).not.toContain(planted);
    } finally {
      setExtensionDirectory(original);
    }
  });

  it("is not looked up by name: autoinstall and autoload are off in the engine that runs a query", async () => {
    const source = join(dir, "y.sqlite");
    writeSqlite(source);
    const engine = await openSource(`${source}#people`);
    try {
      // A name that would autoload an extension in a default engine; it must not load, and nothing is downloaded.
      await expect(engine.query("SELECT * FROM read_json('https://example.com/x.json')")).rejects.toThrow();
      await expect(engine.query("SELECT st_point(1, 2)")).rejects.toThrow();
      await expect(engine.query("SELECT * FROM read_xlsx('/etc/hostname')")).rejects.toThrow();
    } finally {
      engine.close();
    }
  });
});
