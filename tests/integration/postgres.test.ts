import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildCard, mintRef, openSource, peek, renderCard, resolveRef } from "../../packages/core/src/index.ts";

// Runs against a real Postgres, which only the CI job `db-probe` provides (docs/adr/0005). Elsewhere it is skipped.
const host = process.env.FUSEN_PG_HOST ?? "";
const enabled = host !== "";
const port = process.env.FUSEN_PG_PORT ?? "5432";
const db = process.env.FUSEN_PG_DB ?? "probe";
const ADMIN = process.env.FUSEN_PG_ADMIN_PASSWORD ?? "admin";
const RO = process.env.FUSEN_PG_RO_PASSWORD ?? "";
const WRONG = "wrong-password-canary-5521";

const psql = (sql: string) => execFileSync("psql", ["-h", host, "-p", port, "-U", "postgres", "-d", db, "-v", "ON_ERROR_STOP=1", "-Atc", sql], { env: { ...process.env, PGPASSWORD: ADMIN }, encoding: "utf8" });
const profile = (name: string, user: string, env: string) =>
  `[${name}]\nkind = "postgres"\nhost = "${host}"\nport = ${port}\ndbname = "${db}"\nuser = "${user}"\npassword_env = "${env}"\nallow_private = true\nsslmode = "disable"\n`;

describe.skipIf(!enabled)("a Postgres table as a source (docs/adr/0005)", () => {
  const saved = { ...process.env };
  beforeAll(() => {
    const dir = mkdtempSync(join(tmpdir(), "fusen-pg-"));
    const path = join(dir, "connections.toml");
    writeFileSync(path, [profile("ro", "fusen_ro", "FUSEN_PG_RO_PASSWORD"), profile("rw", "fusen_rw", "FUSEN_PG_RW_PASSWORD"), profile("bad", "fusen_ro", "FUSEN_PG_BAD_PASSWORD")].join("\n"));
    chmodSync(path, 0o600);
    process.env.FUSEN_CONNECTIONS = path;
    process.env.FUSEN_PG_BAD_PASSWORD = WRONG;
    psql("drop table if exists public.nokey; create table public.nokey as select g as id from generate_series(1,5) g; grant select on public.nokey to fusen_ro");
  });
  afterAll(() => {
    psql("drop table if exists public.nokey");
    process.env = saved;
  });

  it("opens a table, prints a card, and mints and resolves a Ref that names the connection but not the server", async () => {
    const engine = await openSource("postgres://ro/public.items");
    try {
      const card = renderCard(await buildCard(engine), engine.source);
      expect(card).toContain("100000");
    } finally {
      engine.close();
    }
    const ref = await mintRef("postgres://ro/public.items", { where: "id between 10 and 12" });
    expect(ref).toContain("src=postgres");
    expect(ref).toContain("opt.conn=ro");
    for (const secret of [RO, host, "fusen_ro", db]) expect(ref, `the Ref shows ${secret}`).not.toContain(secret);
    const rows = await resolveRef(ref, { roots: [process.cwd()] });
    expect(rows).toContain("item 10");
    expect(rows).toContain("item 12");
    expect(rows).not.toContain("item 13");
  });

  it("answers 'the data changed' after an insert, and after a change at either end of the key", async () => {
    const ref = await mintRef("postgres://ro/public.items", { where: "id < 5" });
    try {
      expect(await resolveRef(ref, { roots: [process.cwd()] })).toContain("item 1");
      psql("update public.items set name = 'edited' where id = 1");
      expect(await resolveRef(ref, { roots: [process.cwd()] })).toMatch(/changed/i);
      psql("update public.items set name = 'item 1' where id = 1");
      expect(await resolveRef(ref, { roots: [process.cwd()] })).not.toMatch(/data changed/i);
      psql("insert into public.items values (100001, 'new')");
      expect(await resolveRef(ref, { roots: [process.cwd()] })).toMatch(/changed/i);
    } finally {
      psql("delete from public.items where id = 100001");
    }
  });

  it("notices a change in the middle of the key range that leaves the count and both ends as they were", async () => {
    const ref = await mintRef("postgres://ro/public.items", { where: "id < 5" });
    try {
      psql("update public.items set name = 'edited' where id = 50010");
      expect(await resolveRef(ref, { roots: [process.cwd()] })).toMatch(/changed/i);
    } finally {
      psql("update public.items set name = 'item 50010' where id = 50010");
    }
    expect(await resolveRef(ref, { roots: [process.cwd()] })).not.toMatch(/data changed/i);
  });

  it("refuses a role that can write, before reading anything", async () => {
    await expect(openSource("postgres://rw/public.items")).rejects.toThrow(/must only be able to read/);
  });

  it("does not put the password or the server in an error, even from a failed login", async () => {
    const error = await openSource("postgres://bad/public.items").then(() => undefined, (e: Error) => e);
    expect(error).toBeDefined();
    for (const secret of [WRONG, host, "fusen_ro"]) expect(error!.message).not.toContain(secret);
    process.env.FUSEN_DEBUG = "1";
    try {
      const debug = await openSource("postgres://bad/public.items").then(() => undefined, (e: Error) => e);
      for (const secret of [WRONG, RO]) expect(debug!.message).not.toContain(secret);
    } finally {
      delete process.env.FUSEN_DEBUG;
    }
  });

  it("refuses a query that reaches a server by a function, a catalog, or another statement", async () => {
    for (const query of [
      "SELECT * FROM postgres_scan('host=127.0.0.1 port=1 dbname=x', 'public', 't')",
      "SELECT * FROM postgres_query('pg', 'select 1')",
      "SELECT * FROM duckdb_databases()",
      "SELECT * FROM pg.public.items",
    ]) await expect(mintRef("postgres://ro/public.items", { query }), query).rejects.toThrow(/may not use|single SELECT/);
    await expect(mintRef("postgres://ro/public.items", { where: "id IN (SELECT i FROM postgres_query('pg', 'select 1 as i'))" })).rejects.toThrow(/may not use/);
  });

  it("is locked once open: no second connection, no new secret, no write", async () => {
    const engine = await openSource("postgres://ro/public.items");
    try {
      for (const sql of [
        "ATTACH 'host=127.0.0.1' AS other (TYPE postgres)",
        "SET enable_external_access=true",
        "INSERT INTO pg.public.items VALUES (1, 'x')",
        "CALL postgres_execute('pg', 'create table probe_z(i int)')",
      ]) await expect(engine.query(sql), sql).rejects.toThrow();
    } finally {
      engine.close();
    }
    expect(psql("select to_regclass('public.probe_z') is null").trim()).toBe("t");
  });

  it("selects rows by key, and says so for a table with no key or a position", async () => {
    await expect(mintRef("postgres://ro/public.items", { where: "file_row_number = 3" })).rejects.toThrow(/by its key column/);
    await expect(mintRef("postgres://ro/public.nokey", { where: "file_row_number = 3" })).rejects.toThrow(/by its key column/);
    expect(await peek("postgres://ro/public.nokey", { rows: 2 })).toContain("5");
  });

  it("refuses a name that is not a table", async () => {
    await expect(openSource("postgres://ro/public.nope")).rejects.toThrow(/no table/);
    await expect(openSource("postgres://ro/information_schema.tables")).rejects.toThrow(/not a table|no table/);
    await expect(openSource("postgres://nobody/public.items")).rejects.toThrow(/no connection named/);
  });
});
