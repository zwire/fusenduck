import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { serverStatement } from "../../packages/core/src/mysql.ts";
import { KEY, driveTui } from "../helpers/tui.ts";
import { tablesOf, View } from "../../apps/web/src/view.ts";
import { buildCard, listTables, mintRef, openSource, peek, renderCard, resolveRef } from "../../packages/core/src/index.ts";

// Runs against a real MySQL, which only the CI job `mysql-probe` provides (docs/adr/0005). Elsewhere it is skipped.
const host = process.env.FUSEN_MY_HOST ?? "";
const enabled = host !== "";
const port = process.env.FUSEN_MY_PORT ?? "3306";
const db = process.env.FUSEN_MY_DB ?? "probe";
const ADMIN = process.env.FUSEN_MY_ADMIN_PASSWORD ?? "admin";
const RO = process.env.FUSEN_MY_RO_PASSWORD ?? "";
const CA = process.env.FUSEN_MY_CA ?? "";
const WRONG = "wrong-password-canary-5521";

const sql = (text: string) => execFileSync("mysql", ["-h", host, "-P", port, "-u", "root", `-p${ADMIN}`, "--ssl-mode=REQUIRED", "-N", "-B", db, "-e", text], { encoding: "utf8" });
const profile = (name: string, user: string, env: string, extra = `sslmode = "required"\n`) =>
  `[${name}]\nkind = "mysql"\nhost = "${host}"\nport = ${port}\ndbname = "${db}"\nuser = "${user}"\npassword_env = "${env}"\nallow_private = true\n${extra}`;

describe.skipIf(!enabled)("a MySQL table as a source (docs/adr/0005)", () => {
  const saved = { ...process.env };
  beforeAll(() => {
    const dir = mkdtempSync(join(tmpdir(), "fusen-my-"));
    const path = join(dir, "connections.toml");
    writeFileSync(
      path,
      [
        profile("ro", "fusen_ro", "FUSEN_MY_RO_PASSWORD"),
        profile("rw", "fusen_rw", "FUSEN_MY_RW_PASSWORD"),
        profile("bad", "fusen_ro", "FUSEN_MY_BAD_PASSWORD"),
        profile("pinned", "fusen_ro", "FUSEN_MY_RO_PASSWORD", `sslmode = "verify_ca"\nssl_ca = "${CA}"\n`),
        profile("wrongca", "fusen_ro", "FUSEN_MY_RO_PASSWORD", `sslmode = "verify_ca"\nssl_ca = "/etc/hosts"\n`),
        profile("unverified", "fusen_ro", "FUSEN_MY_RO_PASSWORD", `sslmode = "verify_ca"\n`),
      ].join("\n"),
    );
    chmodSync(path, 0o600);
    process.env.FUSEN_CONNECTIONS = path;
    process.env.FUSEN_MY_BAD_PASSWORD = WRONG;
    sql("drop table if exists nokey; create table nokey (id bigint); insert into nokey values (1),(2),(3),(4),(5); grant select on probe.nokey to 'fusen_ro'@'%'");
  });
  afterAll(() => {
    sql("drop table if exists nokey, widekey");
    process.env = saved;
  });

  it("opens a table, prints a card, and mints and resolves a Ref that names the connection but not the server", async () => {
    const engine = await openSource("mysql://ro/items");
    try {
      expect(renderCard(await buildCard(engine), engine.source)).toContain("100000");
    } finally {
      engine.close();
    }
    const ref = await mintRef("mysql://ro/items", { where: "id between 10 and 12" });
    expect(ref).toContain("src=mysql");
    expect(ref).toContain("opt.conn=ro");
    for (const secret of [RO, host, "fusen_ro"]) expect(ref, `the Ref shows ${secret}`).not.toContain(secret);
    const rows = await resolveRef(ref, { roots: [process.cwd()] });
    expect(rows).toContain("item 10");
    expect(rows).toContain("item 12");
    expect(rows).not.toContain("item 13");
  });

  it("answers 'the data changed' after an insert, a change at either end, and a change in the middle of the key range", async () => {
    const ref = await mintRef("mysql://ro/items", { where: "id < 5" });
    try {
      expect(await resolveRef(ref, { roots: [process.cwd()] })).toContain("item 1");
      for (const id of [1, 50010]) {
        sql(`update items set name = 'edited' where id = ${id}`);
        expect(await resolveRef(ref, { roots: [process.cwd()] }), `id ${id}`).toMatch(/changed/i);
        sql(`update items set name = 'item ${id}' where id = ${id}`);
        expect(await resolveRef(ref, { roots: [process.cwd()] }), `id ${id} restored`).not.toMatch(/data changed/i);
      }
      sql("insert into items values (100001, 'new')");
      expect(await resolveRef(ref, { roots: [process.cwd()] })).toMatch(/changed/i);
    } finally {
      sql("delete from items where id = 100001");
    }
  });

  it("refuses a role that can write, before reading anything", async () => {
    await expect(openSource("mysql://rw/items")).rejects.toThrow(/must only be able to read/);
  });

  it("does not put the password or the server in an error, even from a failed login", async () => {
    const error = await openSource("mysql://bad/items").then(() => undefined, (e: Error) => e);
    expect(error).toBeDefined();
    for (const secret of [WRONG, host, "fusen_ro"]) expect(error!.message).not.toContain(secret);
    process.env.FUSEN_DEBUG = "1";
    try {
      const debug = await openSource("mysql://bad/items").then(() => undefined, (e: Error) => e);
      for (const secret of [WRONG, RO]) expect(debug!.message).not.toContain(secret);
    } finally {
      delete process.env.FUSEN_DEBUG;
    }
  });

  it("checks the certificate authority when the profile names one, and refuses to pretend it checks without one", async () => {
    const engine = await openSource("mysql://pinned/items");
    engine.close();
    await expect(openSource("mysql://wrongca/items")).rejects.toThrow(/could not connect/);
    await expect(openSource("mysql://unverified/items")).rejects.toThrow(/needs ssl_ca/);
  });

  it("refuses a query that reaches a server by a function, a catalog, or another statement", async () => {
    for (const query of [
      "SELECT * FROM mysql_query('my', 'select 1')",
      "SELECT * FROM mysql_execute('my', 'select 1')",
      "SELECT * FROM duckdb_databases()",
      "SELECT * FROM my.items",
    ]) await expect(mintRef("mysql://ro/items", { query }), query).rejects.toThrow(/may not use|single SELECT/);
    await expect(mintRef("mysql://ro/items", { where: "id IN (SELECT i FROM mysql_query('my', 'select 1 as i'))" })).rejects.toThrow(/may not use/);
  });

  it("is locked once open: no second connection, no new attach, no write", async () => {
    const engine = await openSource("mysql://ro/items");
    try {
      for (const query of [
        "ATTACH 'host=127.0.0.1' AS other (TYPE mysql)",
        "SET enable_external_access=true",
        "INSERT INTO my.items VALUES (1, 'x')",
        "CALL mysql_execute('my', 'create table probe_z(i int)')",
      ]) await expect(engine.query(query), query).rejects.toThrow();
    } finally {
      engine.close();
    }
    expect(sql("select count(*) from information_schema.tables where table_schema = 'probe' and table_name = 'probe_z'").trim()).toBe("0");
  });

  it("fingerprints a key that spans the whole unsigned range and a table with many wide column names", async () => {
    const cols = Array.from({ length: 60 }, (_, i) => `column_with_a_long_name_${i} int`).join(", ");
    sql(`drop table if exists widekey; create table widekey (id bigint unsigned primary key, ${cols}); insert into widekey (id) values (1), (9223372036854775808), (18446744073709551615); grant select on probe.widekey to 'fusen_ro'@'%'`);
    const ref = await mintRef("mysql://ro/widekey", { where: "id = 1" });
    expect(await resolveRef(ref, { roots: [process.cwd()] })).not.toMatch(/data changed/i);
    sql("alter table widekey add column zz_last int");
    expect(await resolveRef(ref, { roots: [process.cwd()] })).toMatch(/changed/i);
  });

  it("opens in the Web UI's view: a table, no row positions, and a filter that selects by key", async () => {
    const view = await View.open("mysql://ro/items", [process.cwd()]);
    try {
      expect(view.opened).toMatchObject({ kind: "mysql", table: "items", selectable: false });
      const page = await view.rows(view.opened.fingerprint, 0, 3, "id between 2 and 3");
      expect(page.matched).toBe(2);
      const ref = await view.ref(view.opened.fingerprint, [], "id between 2 and 3");
      expect(ref).toContain("src=mysql");
      expect(ref).not.toContain(RO);
    } finally {
      await view.close();
    }
  });

  it("puts a limit on its own statements: the server stops a long one", async () => {
    expect(serverStatement("select 1")).toBe("select /*+ MAX_EXECUTION_TIME(60000) */ 1");
    expect(() => serverStatement("with x as (select 1) select * from x")).toThrow(/must begin with select/);
    expect(() => serverStatement("select 1", 0)).toThrow(/whole number/);
    const engine = await openSource("mysql://ro/items");
    try {
      const heavy = "select sum(a.id * b.id) as s from items a join items b on a.id % 1000 = b.id % 1000";
      const sent = (text: string) => `SELECT * FROM mysql_query('my', '${text}')`;
      const started = Date.now();
      expect((await engine.query(sent(heavy)))[0]).toBeDefined();
      // The same statement takes longer than the limit below, so only the limit can be why it fails.
      expect(Date.now() - started).toBeGreaterThan(150);
      const limited = Date.now();
      await expect(engine.query(sent(serverStatement(heavy, 100)))).rejects.toThrow(/Failed to fetch result row/);
      expect(Date.now() - limited).toBeLessThan(2000);
    } finally {
      engine.close();
    }
  });

  it("lists the tables the role can read, and Web's tablesOf offers the same", async () => {
    sql("drop table if exists `we.ird`; create table `we.ird` (id int); grant select on probe.`we.ird` to 'fusen_ro'@'%'");
    const { tables, truncated } = await listTables("mysql://ro/");
    sql("drop table if exists `we.ird`");
    expect(truncated).toBe(false);
    expect(tables, "a name a Ref cannot carry is not offered").not.toContain("we.ird");
    expect(tables).toContain("items");
    expect(tables).toContain("nokey");
    expect([...tables]).toEqual([...tables].sort());
    expect(await tablesOf("mysql://ro/", [])).toEqual(tables);
    await expect(listTables("mysql://rw/")).rejects.toThrow(/must only be able to read/);
    await expect(listTables("mysql://nobody/")).rejects.toThrow(/nobody/);
  });

  it("the TUI lists the connections, then the connection's tables, and opens the one picked", async () => {
    const tui = driveTui(null, undefined, [mkdtempSync(join(tmpdir(), "fusen-my-tui-"))]);
    try {
      await tui.until((s) => s.includes("mysql connection"), "the connections");
      // Sorted: bad, pinned, ro, rw, wrongca (`unverified` is not a valid profile and is left out).
      await tui.press(KEY.down, KEY.down, KEY.enter);
      await tui.until((s) => s.includes("pick a table") && s.includes("items") && s.includes("nokey"), "the tables");
      await tui.press(KEY.enter);
      await tui.until((s) => s.includes("100000 rows") || s.includes("100,000 rows"), "the table");
    } finally {
      tui.stop();
      await Promise.all(tui.tracked.map((v) => v.close()));
    }
  });

  it("selects rows by key, and says so for a table with no key or a position", async () => {
    await expect(mintRef("mysql://ro/items", { where: "file_row_number = 3" })).rejects.toThrow(/by its key column/);
    await expect(mintRef("mysql://ro/nokey", { where: "file_row_number = 3" })).rejects.toThrow(/by its key column/);
    expect(await peek("mysql://ro/nokey", { rows: 2 })).toContain("5");
  });

  it("refuses a name that is not a table", async () => {
    await expect(openSource("mysql://ro/nope")).rejects.toThrow(/no table/);
    await expect(openSource("mysql://nobody/items")).rejects.toThrow(/no connection named/);
  });
});
