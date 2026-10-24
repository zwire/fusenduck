// Probes what ADR 0005 assumes about DuckDB's mysql extension, against a real MySQL, and prints what it saw.
// Like db-probe.ts it does not assert: every line is an observation that decides the design.
// Needs FUSEN_MY_HOST/PORT/DB, the roles fusen_ro (SELECT only) and fusen_rw (can write), and the mysql client.
import { DuckDBInstance } from "@duckdb/node-api";
import { execFileSync } from "node:child_process";

const env = (name: string): string => process.env[name] ?? "";
const host = env("FUSEN_MY_HOST") || "127.0.0.1";
const port = env("FUSEN_MY_PORT") || "3306";
const db = env("FUSEN_MY_DB") || "probe";
const roPassword = env("FUSEN_MY_RO_PASSWORD");
const rwPassword = env("FUSEN_MY_RW_PASSWORD");
const lit = (s: string) => `'${s.replaceAll("'", "''")}'`;

const lines: string[] = [];
const say = (name: string, result: string) => {
  const text = result.replace(/\s+/g, " ").slice(0, 400);
  lines.push(`| ${name} | ${text.replaceAll("|", "\\|")} |`);
  console.log(`${name}: ${text}`);
};
async function observe(name: string, fn: () => Promise<unknown>) {
  try {
    const value = await fn();
    say(name, `ok${value === undefined ? "" : ` ${typeof value === "string" ? value : JSON.stringify(value)}`}`);
  } catch (error) {
    say(name, `error: ${(error as Error).message}`);
  }
}
const mysql = (user: string, password: string, sql: string): string =>
  execFileSync("mysql", ["-h", host, "-P", port, "-u", user, `-p${password}`, "--ssl-mode=REQUIRED", "-N", "-B", db, "-e", sql], { encoding: "utf8" }).trim();

async function engine(user: string, password: string, secretExtra = "", attachExtra = "READ_ONLY") {
  const instance = await DuckDBInstance.create(":memory:");
  const c = await instance.connect();
  const q = async (sql: string) => (await c.runAndReadAll(sql)).getRowObjectsJson();
  await c.run("SET allowed_paths=[]");
  await c.run("SET memory_limit='512MB'");
  await c.run("SET threads=4");
  await c.run("SET temp_directory=''");
  await c.run("INSTALL mysql");
  await c.run("LOAD mysql");
  return {
    instance,
    c,
    q,
    attach: async () => {
      await c.run(`CREATE SECRET mys (TYPE mysql, HOST ${lit(host)}, PORT ${port}, DATABASE ${lit(db)}, USER ${lit(user)}, PASSWORD ${lit(password)}${secretExtra})`);
      await c.run(`ATTACH '' AS my (TYPE mysql, SECRET mys${attachExtra ? `, ${attachExtra}` : ""})`);
    },
  };
}
const lockdown = async (c: { run(sql: string): Promise<unknown> }) => {
  await c.run("CREATE TEMP VIEW data AS SELECT * FROM my.items");
  await c.run("SET enable_external_access=false");
  await c.run("SET lock_configuration=true");
};

await observe("server version", async () => mysql("fusen_ro", roPassword, "select version()"));
await observe("duckdb version", async () => (await (await DuckDBInstance.create(":memory:")).connect().then((c) => c.runAndReadAll("select version() v"))).getRowObjectsJson());

// 1. Connect before the lock; default TLS behaviour; the ssl_mode values the secret accepts.
{
  const e = await engine("fusen_ro", roPassword);
  await observe("1a connect with the secret, default ssl_mode (server has no TLS certificate we trust)", e.attach);
}
for (const mode of ["disabled", "preferred", "required", "verify_ca", "verify_identity"]) {
  const e = await engine("fusen_ro", roPassword, `, SSL_MODE ${lit(mode)}`);
  await observe(`1b ssl_mode=${mode}`, e.attach);
}
{
  const e = await engine("fusen_ro", roPassword, ", SSL_MODE 'disabled'");
  await observe("1c connect before the lock", e.attach);
  await observe("1d lock after the connection", () => lockdown(e.c));
  await observe("1e read the view after the lock", () => e.q("SELECT count(*) AS n, min(id) AS lo, max(id) AS hi FROM data"));
  await observe("1f scan with threads=4: server connections held", async () => {
    await e.q("SELECT count(*) AS n FROM data WHERE id % 7 = 0");
    return mysql("fusen_ro", roPassword, "select count(*) from information_schema.processlist where user='fusen_ro'");
  });
  await observe("1g session is read only?", () => e.q("SELECT * FROM mysql_query('my', 'select @@session.transaction_read_only as ro, @@session.sql_mode as mode')"));
}

// 2. After the lock: more reach, other servers, writes.
{
  const e = await engine("fusen_ro", roPassword, ", SSL_MODE 'disabled'");
  await e.attach();
  await lockdown(e.c);
  await observe("2a ATTACH again after the lock", () => e.c.run(`ATTACH ${lit(`host=${host} port=${port} user=fusen_ro password=${roPassword} database=${db} ssl_mode=disabled`)} AS my2 (TYPE mysql, READ_ONLY)`));
  await observe("2c mysql_query after the lock", () => e.q("SELECT * FROM mysql_query('my', 'select 1 as one')"));
  await observe("2d mysql_execute after the lock (role is SELECT only)", () => e.q("CALL mysql_execute('my', 'create table probe_x(i int)')"));
  await observe("2e INSERT through the attached catalog", () => e.c.run("INSERT INTO my.items VALUES (999999, 'x')"));
  await observe("2f CREATE SECRET after the lock", () => e.c.run("CREATE SECRET evil (TYPE mysql, HOST '127.0.0.1', PORT 1)"));
  await observe("2g mysql_scan with a connection string after the lock", () => e.q(`SELECT * FROM mysql_scan(${lit(`host=127.0.0.1 port=1 user=x database=${db}`)}, ${lit(db)}, 'items')`));
  await observe("2h INSTALL after the lock", () => e.c.run("INSTALL postgres"));
  await observe("2i mysql_scan / mysql_attach style functions that exist", () => e.q("SELECT function_name FROM duckdb_functions() WHERE function_name LIKE 'mysql%' GROUP BY 1"));
  await observe("2j DETACH after the lock", () => e.c.run("DETACH my"));
  await observe("2k mysql_query after DETACH", () => e.q("SELECT * FROM mysql_query('my', 'select 1 as one')"));
}

// 3. A write-capable role: which layer stops a write.
{
  const e = await engine("fusen_rw", rwPassword, ", SSL_MODE 'disabled'");
  await e.attach();
  await observe("3a READ_ONLY attach, INSERT with a writable role", () => e.c.run("INSERT INTO my.items VALUES (888888, 'x')"));
  await observe("3b READ_ONLY attach, mysql_execute with a writable role", () => e.q("CALL mysql_execute('my', 'create table probe_y(i int)')"));
  await observe("3c server shows probe_y", async () => mysql("fusen_ro", roPassword, "select count(*) from information_schema.tables where table_schema='probe' and table_name='probe_y'"));
  await observe("3d mysql_query can write with a writable role", () => e.q("SELECT * FROM mysql_query('my', 'delete from items where id = 888888')"));
}

// 4. The role check, through the engine's own connection.
{
  const e = await engine("fusen_ro", roPassword, ", SSL_MODE 'disabled'");
  await e.attach();
  await observe("4a SHOW GRANTS FOR CURRENT_USER() through mysql_query (ro)", () => e.q("SELECT * FROM mysql_query('my', 'SHOW GRANTS FOR CURRENT_USER()')"));
  await observe("4b current_user / roles through mysql_query", () => e.q("SELECT * FROM mysql_query('my', 'select current_user() as u, current_role() as r, database() as d')"));
  const w = await engine("fusen_rw", rwPassword, ", SSL_MODE 'disabled'");
  await w.attach();
  await observe("4c SHOW GRANTS FOR CURRENT_USER() (rw, should show more than SELECT)", () => w.q("SELECT * FROM mysql_query('my', 'SHOW GRANTS FOR CURRENT_USER()')"));
}

// 5. Where the password shows.
const leaks = async (q: (sql: string) => Promise<Record<string, unknown>[]>, password: string) => {
  const found: string[] = [];
  for (const [name, sql] of [["duckdb_databases", "SELECT * FROM duckdb_databases()"], ["duckdb_secrets", "SELECT * FROM duckdb_secrets()"], ["duckdb_settings", "SELECT * FROM duckdb_settings()"], ["database_list", "PRAGMA database_list"], ["duckdb_extensions", "SELECT * FROM duckdb_extensions()"], ["duckdb_views", "SELECT * FROM duckdb_views()"]] as const) {
    try {
      for (const row of await q(sql)) for (const [column, value] of Object.entries(row)) if (JSON.stringify(value)?.includes(password)) found.push(`${name}.${column}`);
    } catch (error) {
      found.push(`${name}: error ${(error as Error).message.slice(0, 60)}`);
    }
  }
  return found.length ? `LEAKS in ${found.join(", ")}` : "no password in any of them";
};
{
  const e = await engine("fusen_ro", roPassword, ", SSL_MODE 'disabled'");
  await e.attach();
  await lockdown(e.c);
  await observe("5a secret route: where the password shows", () => leaks(e.q, roPassword));
}

// 6. What a fingerprint and a key lookup need from the server.
{
  const e = await engine("fusen_ro", roPassword, ", SSL_MODE 'disabled'");
  await e.attach();
  await observe("6a count, max key, columns in one statement", () =>
    e.q(`SELECT * FROM mysql_query('my', ${lit("select (select count(*) from items) as n, (select max(id) from items) as maxkey, (select group_concat(column_name, ':', column_type, ':', is_nullable order by ordinal_position) from information_schema.columns where table_schema = database() and table_name = 'items') as cols, database() as db, @@server_uuid as sys")})`));
  await observe("6b estimate: table_rows", () => e.q(`SELECT * FROM mysql_query('my', ${lit("select table_rows as n, data_length + index_length as bytes, table_type as kind from information_schema.tables where table_schema = database() and table_name = 'items'")})`));
  await observe("6c primary key columns", () =>
    e.q(`SELECT * FROM mysql_query('my', ${lit("select group_concat(column_name order by seq_in_index) as pk from information_schema.statistics where table_schema = database() and table_name = 'items' and index_name = 'PRIMARY'")})`));
  await observe("6d sample hash (md5 of group_concat of rows), 50 rows from each end", () =>
    e.q(`SELECT * FROM mysql_query('my', ${lit("select md5(group_concat(json_object('id', id, 'name', name) order by id separator ';')) as head from (select * from items order by id asc limit 50) x")})`));
  await observe("6e a view, is it in information_schema.tables", async () => mysql("fusen_ro", roPassword, "select count(*) from information_schema.tables where table_schema = 'probe' and table_type = 'VIEW'"));
}

// 7. Is the connection encrypted, per ssl_mode? (The secret accepted every mode above, even against a self-signed certificate.)
for (const mode of ["disabled", "preferred", "required", "verify_ca", "verify_identity"]) {
  const e = await engine("fusen_ro", roPassword, `, SSL_MODE ${lit(mode)}`);
  await observe(`7a ssl_mode=${mode}: attach, then the session cipher`, async () => {
    await e.attach();
    return e.q(`SELECT * FROM mysql_query('my', ${lit("select variable_value as cipher from performance_schema.session_status where variable_name = 'Ssl_cipher'")})`);
  });
}
{
  const instance = await DuckDBInstance.create(":memory:");
  const c = await instance.connect();
  await c.run("INSTALL mysql");
  await c.run("LOAD mysql");
  await c.run(`CREATE SECRET bad (TYPE mysql, HOST ${lit(host)}, PORT ${port}, DATABASE ${lit(db)}, USER 'fusen_ro', PASSWORD 'wrong-password-canary-1')`);
  await observe("7b wrong password: is the attach eager, and does the error show the password", () => c.run("ATTACH '' AS my (TYPE mysql, SECRET bad, READ_ONLY)"));
}

// 8. Does the client library read ~/.my.cnf or MYSQL_* variables behind the secret?
{
  const { mkdtempSync, writeFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const home = mkdtempSync(join(tmpdir(), "mycnf-"));
  writeFileSync(join(home, ".my.cnf"), "[client]\ninit-command=SET @from_cnf=1\n");
  const saved = { HOME: process.env.HOME, MYSQL_PWD: process.env.MYSQL_PWD, MYSQL_HOST: process.env.MYSQL_HOST };
  process.env.HOME = home;
  process.env.MYSQL_HOST = "192.0.2.1";
  process.env.MYSQL_PWD = "env-password-canary";
  const e = await engine("fusen_ro", roPassword, ", SSL_MODE 'required'");
  await observe("8a ~/.my.cnf init-command and MYSQL_HOST/MYSQL_PWD present: attach and read @from_cnf", async () => {
    await e.attach();
    return e.q("SELECT * FROM mysql_query('my', 'select @from_cnf as from_cnf')");
  });
  for (const [k, v] of Object.entries(saved)) if (v === undefined) delete process.env[k]; else process.env[k] = v;
}

// 9. What the role check can see without SHOW GRANTS.
{
  const e = await engine("fusen_ro", roPassword, ", SSL_MODE 'required'");
  await e.attach();
  const w = await engine("fusen_rw", rwPassword, ", SSL_MODE 'required'");
  await w.attach();
  for (const [who, x] of [["ro", e], ["rw", w]] as const) {
    await observe(`9a ${who}: information_schema.user_privileges`, () => x.q(`SELECT * FROM mysql_query('my', ${lit("select grantee, privilege_type, is_grantable from information_schema.user_privileges")})`));
    await observe(`9b ${who}: information_schema.schema_privileges`, () => x.q(`SELECT * FROM mysql_query('my', ${lit("select grantee, table_schema, privilege_type, is_grantable from information_schema.schema_privileges")})`));
    await observe(`9c ${who}: information_schema.table_privileges`, () => x.q(`SELECT * FROM mysql_query('my', ${lit("select table_schema, table_name, privilege_type from information_schema.table_privileges")})`));
    await observe(`9d ${who}: enabled roles / SUPER-like`, () => x.q(`SELECT * FROM mysql_query('my', ${lit("select current_role() as r, @@global.read_only as ro, @@global.super_read_only as sro")})`));
  }
}

// 10. Does the secret enforce verification? (verify_ca and verify_identity connected to a self-signed server above.)
{
  const ca = env("FUSEN_MY_CA");
  const cases: [string, string][] = [
    ["verify_ca, no ssl_ca (self-signed server)", ", SSL_MODE 'verify_ca'"],
    ["verify_ca, ssl_ca = a file that is not the server's CA", ", SSL_MODE 'verify_ca', SSL_CA '/etc/hosts'"],
    ["verify_ca, ssl_ca = the server's CA", `, SSL_MODE 'verify_ca', SSL_CA ${lit(ca)}`],
    ["verify_identity, ssl_ca = the server's CA, host is an IP", `, SSL_MODE 'verify_identity', SSL_CA ${lit(ca)}`],
    ["required, ssl_ca = a file that is not the server's CA", ", SSL_MODE 'required', SSL_CA '/etc/hosts'"],
  ];
  for (const [name, extra] of cases) {
    const e = await engine("fusen_ro", roPassword, extra);
    await observe(`10 ${name}: attach and the session cipher`, async () => {
      await e.attach();
      return e.q(`SELECT * FROM mysql_query('my', ${lit("select variable_value as cipher from performance_schema.session_status where variable_name = 'Ssl_cipher'")})`);
    });
  }
}

// 11. Can the server be made to stop a long statement? (No timeout option is known for the secret or the attach.)
{
  const slow = "select count(*) as n from items a join items b join items c";
  const through = (sql: string) => `SELECT * FROM mysql_query('my', ${lit(sql)})`;
  const e = await engine("fusen_ro", roPassword);
  await e.attach();
  await observe("11a duckdb settings that mention mysql", async () => e.q("select name from duckdb_settings() where name like '%mysql%' or name like '%timeout%'"));
  await observe("11b SET SESSION max_execution_time through mysql_query", async () => e.q(through("set session max_execution_time = 1000")));
  await observe("11c max_execution_time seen by 8 later statements (one connection or several?)", async () => {
    const seen = new Set<string>();
    for (let i = 0; i < 8; i++) seen.add(JSON.stringify(await e.q(through("select @@session.max_execution_time as t, connection_id() as id"))));
    return [...seen];
  });
  await observe("11d a slow statement through mysql_query after that SET: how long, what error", async () => {
    const start = Date.now();
    try {
      await e.q(through(slow));
      return `finished in ${Date.now() - start} ms`;
    } catch (error) {
      return `error after ${Date.now() - start} ms: ${(error as Error).message}`;
    }
  });
  for (const key of ["CONNECT_TIMEOUT 5", "READ_TIMEOUT 5", "TIMEOUT 5", "INIT_COMMAND 'set session max_execution_time=1000'"]) {
    const x = await engine("fusen_ro", roPassword, `, ${key}`);
    await observe(`11e secret key ${key}`, async () => {
      await x.attach();
      return x.q(through("select @@session.max_execution_time as t"));
    });
  }
  const slept = await engine("fusen_ro", roPassword);
  await slept.attach();
  await observe("11f interrupt of a blocked statement (select sleep(8)): how long until it returns", async () => {
    const start = Date.now();
    setTimeout(() => slept.c.interrupt(), 1000);
    try {
      await slept.q(through("select sleep(8) as s"));
      return `finished in ${Date.now() - start} ms`;
    } catch (error) {
      return `error after ${Date.now() - start} ms: ${(error as Error).message}`;
    }
  });
}

// 12. Hints, the extension's settings, and a kill from another connection.
{
  const through = (alias: string, sql: string) => `SELECT * FROM mysql_query('${alias}', ${lit(sql)})`;
  const timed = async (fn: () => Promise<unknown>) => {
    const start = Date.now();
    try {
      const value = await fn();
      return `finished in ${Date.now() - start} ms ${JSON.stringify(value).slice(0, 120)}`;
    } catch (error) {
      return `error after ${Date.now() - start} ms: ${(error as Error).message}`;
    }
  };
  const e = await engine("fusen_ro", roPassword);
  await e.attach();
  const names = (await e.q("select name from duckdb_settings() where name like 'mysql%' order by name")).map((r) => String((r as { name: string }).name));
  for (let i = 0; i < names.length; i += 8) say(`12a mysql settings ${i / 8 + 1}`, names.slice(i, i + 8).join(" "));
  await observe("12b hint MAX_EXECUTION_TIME(1000) on select sleep(5)", async () => timed(() => e.q(through("my", "select /*+ MAX_EXECUTION_TIME(1000) */ sleep(5) as s"))));
  const heavy = "select sum(a.id * b.id) as s from items a join items b on a.id % 1000 = b.id % 1000";
  await observe("12c the heavy join without a hint", async () => timed(() => e.q(through("my", heavy))));
  await observe("12d the heavy join with MAX_EXECUTION_TIME(300)", async () => timed(() => e.q(through("my", heavy.replace("select", "select /*+ MAX_EXECUTION_TIME(300) */")))));
  await observe("12e hint on a scan-shaped statement through the view's own scan (no hint possible): count over my.items", async () => timed(() => e.q("select count(*) as n from my.items")));

  // A second, separate attach used only to kill the first one's statement.
  const k = await engine("fusen_ro", roPassword);
  await k.attach();
  const killer = await DuckDBInstance.create(":memory:");
  const kc = await killer.connect();
  await kc.run("INSTALL mysql");
  await kc.run("LOAD mysql");
  await kc.run(`CREATE SECRET mys (TYPE mysql, HOST ${lit(host)}, PORT ${port}, DATABASE ${lit(db)}, USER 'fusen_ro', PASSWORD ${lit(roPassword)})`);
  await kc.run("ATTACH '' AS my2 (TYPE mysql, SECRET mys)");
  await observe("12f KILL QUERY through mysql_execute on a writable attach, as the SELECT-only role", async () => {
    const running = timed(() => k.q(through("my", "select sleep(8) as s")));
    await new Promise((r) => setTimeout(r, 1000));
    const ids = (await (await kc.runAndReadAll(through("my2", "select id from information_schema.processlist where info like '%sleep(8)%' and info not like '%processlist%'"))).getRowObjectsJson()) as { id: string }[];
    const killed = await kc.run(`CALL mysql_execute('my2', ${lit(`KILL QUERY ${Number(ids[0]?.id)}`)})`).then(() => "kill sent", (error) => `kill failed: ${(error as Error).message}`);
    return `${killed}; ids ${JSON.stringify(ids)}; the statement: ${await running}`;
  });
}

const summary = process.env.GITHUB_STEP_SUMMARY;
if (summary) {
  const { appendFileSync } = await import("node:fs");
  appendFileSync(summary, `\n### mysql extension probe\n\n| observation | result |\n|---|---|\n${lines.join("\n")}\n`);
}
