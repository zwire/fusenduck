// Probes the assumptions ADR 0005 section 6 rests on, against a real Postgres, and prints what it saw.
// It does not assert: the answers decide the design (see the ADR), so every line is an observation.
// Needs FUSEN_PG_HOST/PORT/DB and two roles set up by the CI job: fusen_ro (SELECT only) and fusen_rw (can write).
import { DuckDBInstance } from "@duckdb/node-api";
import { execFileSync } from "node:child_process";

const env = (name: string): string => process.env[name] ?? "";
const host = env("FUSEN_PG_HOST") || "127.0.0.1";
const port = env("FUSEN_PG_PORT") || "5432";
const db = env("FUSEN_PG_DB") || "probe";
const lit = (s: string) => `'${s.replaceAll("'", "''")}'`;
const conninfo = (user: string, password: string, extra = "") => `host=${host} port=${port} dbname=${db} user=${user} password=${password}${extra}`;

const lines: string[] = [];
const say = (name: string, result: string) => {
  const text = result.replace(/\s+/g, " ").slice(0, 300);
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
const psql = (user: string, password: string, sql: string): string =>
  execFileSync("psql", ["-h", host, "-p", port, "-U", user, "-d", db, "-Atc", sql], { env: { ...process.env, PGPASSWORD: password }, encoding: "utf8" }).trim();

const roPassword = env("FUSEN_PG_RO_PASSWORD");
const rwPassword = env("FUSEN_PG_RW_PASSWORD");

async function engine(user: string, password: string, extra = "", readOnly = true) {
  const instance = await DuckDBInstance.create(":memory:");
  const c = await instance.connect();
  const q = async (sql: string) => (await c.runAndReadAll(sql)).getRowObjectsJson();
  // The engine's own order (packages/core/src/engine.ts), with the connection made before external access is switched off.
  await c.run("SET allowed_paths=[]");
  await c.run("SET memory_limit='512MB'");
  await c.run("SET threads=4");
  await c.run("SET temp_directory=''");
  return { instance, c, q, attach: () => c.run(`ATTACH ${lit(conninfo(user, password, extra))} AS pg (TYPE postgres${readOnly ? ", READ_ONLY" : ""})`) };
}
const lockdown = async (c: { run(sql: string): Promise<unknown> }) => {
  await c.run("CREATE TEMP VIEW data AS SELECT * FROM pg.public.items");
  await c.run("SET enable_external_access=false");
  await c.run("SET lock_configuration=true");
};

await observe("duckdb version", async () => (await (await DuckDBInstance.create(":memory:")).connect().then((c) => c.runAndReadAll("select version() v"))).getRowObjectsJson());
await observe("INSTALL + LOAD postgres", async () => {
  const instance = await DuckDBInstance.create(":memory:");
  const c = await instance.connect();
  await c.run("INSTALL postgres");
  await c.run("LOAD postgres");
});

// 1. A connection made before the lock keeps working after it.
{
  const e = await engine("fusen_ro", roPassword);
  await observe("1a connect before the lock", async () => { await e.c.run("LOAD postgres"); await e.attach(); });
  await observe("1b lock after the connection", () => lockdown(e.c));
  await observe("1c read the view after the lock", () => e.q("SELECT count(*) AS n, min(id) AS lo, max(id) AS hi FROM data"));
  await observe("1d scan with threads=4: server connections held", async () => {
    await e.q("SELECT count(*) AS n FROM data WHERE id % 7 = 0");
    return psql("fusen_ro", roPassword, "select count(*) from pg_stat_activity where usename='fusen_ro' and pid <> pg_backend_pid()");
  });

  // 2. After the lock a query cannot reach more of the server, or other servers.
  await observe("2a ATTACH again after the lock", () => e.c.run(`ATTACH ${lit(conninfo("fusen_ro", roPassword))} AS pg2 (TYPE postgres, READ_ONLY)`));
  await observe("2b DETACH after the lock", () => e.c.run("DETACH pg"));
  await observe("2c re-ATTACH read-write after DETACH", () => e.c.run(`ATTACH ${lit(conninfo("fusen_ro", roPassword))} AS pg3 (TYPE postgres)`));
  await observe("2d LOAD a second time / INSTALL", () => e.c.run("INSTALL mysql"));
  await e.instance.closeSync?.();
}
{
  const e = await engine("fusen_ro", roPassword);
  await e.c.run("LOAD postgres");
  await e.attach();
  await lockdown(e.c);
  await observe("2e postgres_query after the lock", () => e.q("SELECT * FROM postgres_query('pg', 'select 1 as one')"));
  await observe("2f postgres_execute after the lock (role is SELECT only)", () => e.q("CALL postgres_execute('pg', 'create table probe_x(i int)')"));
  await observe("2g INSERT through the attached catalog", () => e.c.run("INSERT INTO pg.public.items VALUES (999999, 'x')"));
  await observe("2h duckdb_databases() after the lock", async () => JSON.stringify(await e.q("SELECT database_name, path FROM duckdb_databases()")).replaceAll(roPassword, "<PASSWORD>") + (JSON.stringify(await e.q("SELECT * FROM duckdb_databases()")).includes(roPassword) ? " LEAKS PASSWORD" : " no password"));
  await observe("2i duckdb_secrets() after the lock", async () => (JSON.stringify(await e.q("SELECT * FROM duckdb_secrets()")).includes(roPassword) ? "LEAKS PASSWORD" : "no password"));
  await observe("2j duckdb_settings() / PRAGMA database_list", async () => (JSON.stringify(await e.q("PRAGMA database_list")) + JSON.stringify(await e.q("SELECT name, value FROM duckdb_settings()"))).includes(roPassword) ? "LEAKS PASSWORD" : "no password");
  await observe("2k autoload: scanner function by name", () => e.q("SELECT * FROM postgres_scan('host=127.0.0.1 port=1 dbname=x', 'public', 'items')"));
}

// 3. A write-capable role: which layer stops a write.
{
  const e = await engine("fusen_rw", rwPassword, "", true);
  await e.c.run("LOAD postgres");
  await e.attach();
  await observe("3a READ_ONLY attach, INSERT with a writable role", () => e.c.run("INSERT INTO pg.public.items VALUES (888888, 'x')"));
  await observe("3b READ_ONLY attach, postgres_execute with a writable role", () => e.q("CALL postgres_execute('pg', 'create table probe_y(i int)')"));
  await observe("3c server shows probe_y", async () => psql("fusen_ro", roPassword, "select to_regclass('public.probe_y') is not null"));
}
{
  const e = await engine("fusen_rw", rwPassword, " options='-c default_transaction_read_only=on'", true);
  await e.c.run("LOAD postgres");
  await observe("3d options=-c default_transaction_read_only=on accepted", e.attach);
  await observe("3e that option, postgres_execute with a writable role", () => e.q("CALL postgres_execute('pg', 'create table probe_z(i int)')"));
}

// 4. The role check queries run as the SELECT-only role.
await observe("4a role check: write privileges over every table", async () =>
  psql("fusen_ro", roPassword, "select count(*) from pg_class c join pg_namespace n on n.oid=c.relnamespace where c.relkind in ('r','p') and n.nspname not in ('pg_catalog','information_schema') and (has_any_column_privilege(c.oid,'INSERT,UPDATE') or has_table_privilege(c.oid,'INSERT,UPDATE,DELETE,TRUNCATE'))"));
await observe("4b role check: database and role flags", async () =>
  psql("fusen_ro", roPassword, "select has_database_privilege(current_database(),'CREATE,TEMP'), r.rolsuper, r.rolcreaterole, r.rolbypassrls, pg_has_role(current_user,'pg_write_all_data','member') from pg_roles r where r.rolname=current_user"));
await observe("4c role check on the writable role (should flag)", async () =>
  psql("fusen_rw", rwPassword, "select count(*) from pg_class c join pg_namespace n on n.oid=c.relnamespace where c.relkind in ('r','p') and n.nspname not in ('pg_catalog','information_schema') and (has_any_column_privilege(c.oid,'INSERT,UPDATE') or has_table_privilege(c.oid,'INSERT,UPDATE,DELETE,TRUNCATE'))"));

// 5. Where the password shows when it is in the connection string, and whether a secret avoids that.
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
  const e = await engine("fusen_ro", roPassword);
  await e.c.run("LOAD postgres");
  await e.attach();
  await lockdown(e.c);
  await observe("5a password in the ATTACH string: where it shows", () => leaks(e.q, roPassword));
}
{
  const instance = await DuckDBInstance.create(":memory:");
  const c = await instance.connect();
  const q = async (sql: string) => (await c.runAndReadAll(sql)).getRowObjectsJson();
  await c.run("LOAD postgres");
  await observe("5b CREATE SECRET + ATTACH with the secret", async () => {
    await c.run(`CREATE SECRET pgs (TYPE postgres, HOST ${lit(host)}, PORT ${port}, DATABASE ${lit(db)}, USER 'fusen_ro', PASSWORD ${lit(roPassword)})`);
    await c.run("ATTACH '' AS pg (TYPE postgres, SECRET pgs, READ_ONLY)");
  });
  await observe("5c secret route: view, lock, read", async () => {
    await c.run("CREATE TEMP VIEW data AS SELECT * FROM pg.public.items");
    await c.run("SET enable_external_access=false");
    await c.run("SET lock_configuration=true");
    return q("SELECT count(*) AS n FROM data");
  });
  await observe("5d secret route: where the password shows", () => leaks(q, roPassword));
  await observe("5e secret route: postgres_scan with the secret name from a query", () => q("SELECT * FROM postgres_scan('', 'public', 'items')"));
  await observe("5f secret route: CREATE SECRET after the lock", () => c.run("CREATE SECRET evil (TYPE postgres, HOST '127.0.0.1', PORT 1)"));
}

// 6. What a parse tree shows, for a guard on functions that reach a server.
{
  const instance = await DuckDBInstance.create(":memory:");
  const c = await instance.connect();
  await c.run("LOAD postgres");
  const names = (node: unknown, out: Set<string> = new Set()): Set<string> => {
    if (Array.isArray(node)) node.forEach((n) => names(n, out));
    else if (node && typeof node === "object") {
      for (const [key, value] of Object.entries(node)) {
        if ((key === "function_name" || key === "table_name") && typeof value === "string") out.add(value);
        else names(value, out);
      }
    }
    return out;
  };
  const cases: Record<string, string> = {
    plain: "SELECT * FROM postgres_scan('h','public','t')",
    quoted: 'SELECT * FROM "POSTGRES_SCAN"(\'h\',\'public\',\'t\')',
    qualified: "SELECT * FROM main.postgres_scan('h','public','t')",
    cte: "WITH x AS (SELECT * FROM postgres_query('pg','select 1')) SELECT * FROM x",
    subquery: "SELECT (SELECT count(*) FROM mysql_scan('h','d','t'))",
    lateral: "SELECT * FROM data, LATERAL (SELECT * FROM postgres_scan('h','public','t')) y",
    in_list: "SELECT * FROM data WHERE id IN (SELECT i FROM postgres_query('pg','select 1 as i'))",
    attach: "ATTACH 'host=x' AS z (TYPE postgres)",
    call: "CALL postgres_execute('pg','select 1')",
    pragma: "PRAGMA database_list",
    copy: "COPY (SELECT 1) TO 'x.csv'",
    secrets: "SELECT * FROM duckdb_secrets()",
  };
  for (const [name, sql] of Object.entries(cases)) {
    await observe(`6 parse tree: ${name}`, async () => {
      const rows = await (await c.runAndReadAll(`SELECT json_serialize_sql(${lit(sql)}) AS j`)).getRowObjectsJson();
      const tree = JSON.parse(String(rows[0]!.j));
      return tree.error ? `parse error: ${String(tree.error_message).slice(0, 80)}` : `names: ${[...names(tree)].join(",")}`;
    });
  }
}

const table = `## ADR 0005 database probe\n\n| Observation | Result |\n| --- | --- |\n${lines.join("\n")}\n`;
if (process.env.GITHUB_STEP_SUMMARY) (await import("node:fs")).appendFileSync(process.env.GITHUB_STEP_SUMMARY, table);
