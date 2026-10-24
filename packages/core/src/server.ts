import { createHash } from "node:crypto";
import { DuckDBInstance } from "@duckdb/node-api";
import { loadProfile, readPassword, resolveHost, type Profile } from "./connections.ts";
import type { Engine } from "./engine.ts";
import { bundledExtension } from "./extensions.ts";
import { FusenError } from "./errors.ts";
import { createQuery, type Row } from "./run.ts";
import { ident, lit } from "./sql.ts";
import type { SourceAdapter, SourceOptions } from "./source.ts";

/**
 * A table of a database server (docs/adr/0005). The source is named `postgres://<connection>/<schema>.<table>`;
 * the Ref carries the connection's name and the table, never the server's address or a password.
 */
export const isServerSource = (source: string): boolean => /^postgres:\/\//.test(source);

const PART = /^[^."\\\0*?]{1,63}$/;
const CONNECTION = /^[a-z][a-z0-9_-]{0,31}$/;

/** The options a server Ref carries, from `postgres://conn/schema.table`. */
export function serverOptions(source: string): SourceOptions {
  const match = /^postgres:\/\/([^/]+)\/(.+)$/.exec(source);
  if (!match) throw new FusenError("a database source is written postgres://<connection>/<schema>.<table>");
  return { conn: match[1]!, table: match[2]! };
}

function checkOptions(options: SourceOptions): { conn: string; schema: string; table: string } {
  const keys = Object.keys(options);
  if (keys.some((k) => k !== "conn" && k !== "table")) throw new FusenError("a database source takes only opt.conn and opt.table");
  const { conn, table } = options;
  if (!conn || !CONNECTION.test(conn)) throw new FusenError("opt.conn must be the name of a connection");
  const parts = (table ?? "").split(".");
  if (parts.length !== 2 || !parts.every((p) => PART.test(p))) throw new FusenError("opt.table must be <schema>.<table>, without dots or quotes inside the names");
  return { conn, schema: parts[0]!, table: parts[1]! };
}

/** The server's table, as the relation and the key the adapter learned when it was opened. */
interface Relation {
  /** Primary key columns, in order. Empty when the table has none, and rows are then not selectable. */
  keys: string[];
  tuples: number;
}

/** How many rows are counted exactly; a larger table is estimated, so the card does not scan it twice. */
const EXACT_COUNT_MAX = 100_000;
/** Seconds the one connection may take to be made, and milliseconds the server may spend on a statement or a lock. */
const CONNECT_TIMEOUT_SECONDS = 10;
const STATEMENT_TIMEOUT_MS = 60_000;
/** Rows read from each end of the key for the sample hash. */
const SAMPLE_ROWS = 50;

const pg = (sql: string): string => `SELECT * FROM postgres_query('pg', ${lit(sql)})`;

export function serverAdapter(options: SourceOptions, relation?: Relation): SourceAdapter {
  const { schema, table } = checkOptions(options);
  const stored = `${ident(schema)}.${ident(table)}`;
  const adapter: SourceAdapter = {
    name: "postgres",
    options,
    database: false,
    server: true,
    resolve: async () => adapter,
    read: () => "data",
    allowedPaths: () => [],
    positionView: () => {
      throw new FusenError("a database table is opened alone");
    },
    rowPosition: "file_row_number",
    baseQuery(_path, withPosition = false) {
      // A Ref names its adapter by kind and options only, so the key columns are not known here.
      if (withPosition) throw new FusenError("rows of a database table are selected by its key column, such as where id = 5, not by position");
      return "SELECT * FROM data";
    },
    async fingerprint(engine) {
      const keys = relation?.keys ?? [];
      const regclass = lit(stored);
      const order = keys.map(ident).join(", ");
      const exact = (relation?.tuples ?? 0) <= EXACT_COUNT_MAX;
      const sample = (direction: string) =>
        keys.length
          ? `(SELECT md5(coalesce(string_agg(to_jsonb(x)::text, ';'), '')) FROM (SELECT * FROM ${stored} ORDER BY ${keys.map((k) => `${ident(k)} ${direction}`).join(", ")} LIMIT ${SAMPLE_ROWS}) x)`
          : "''";
      const sql = `SELECT ${exact ? `(SELECT count(*) FROM ${stored})::text` : `(SELECT reltuples::bigint FROM pg_class WHERE oid = ${regclass}::regclass)::text`} AS n,
        ${keys.length ? `(SELECT row(${order})::text FROM ${stored} ORDER BY ${keys.map((k) => `${ident(k)} DESC`).join(", ")} LIMIT 1)` : "''"} AS maxkey,
        (SELECT md5(string_agg(a.attname || ':' || format_type(a.atttypid, a.atttypmod) || ':' || a.attnotnull::text, ',' ORDER BY a.attnum))
           FROM pg_attribute a WHERE a.attrelid = ${regclass}::regclass AND a.attnum > 0 AND NOT a.attisdropped) AS cols,
        ${sample("ASC")} AS head, ${sample("DESC")} AS tail, current_database() AS db,
        (SELECT oid FROM pg_database WHERE datname = current_database())::text AS sys`;
      // One statement, so the count, the key and the sample come from one snapshot (the attach is a READ ONLY transaction).
      const row = (await engine.query(pg(sql)))[0] ?? {};
      return createHash("sha256")
        .update(`postgres:${exact ? "exact" : "estimate"}:${["n", "maxkey", "cols", "head", "tail", "db", "sys"].map((k) => String(row[k])).join(":")}`)
        .digest("hex")
        .slice(0, 12);
    },
    async scanBytes(engine) {
      const row = (await engine.query(pg(`SELECT pg_table_size(${lit(stored)}::regclass)::text AS bytes`)))[0];
      return Number(row?.bytes ?? 0);
    },
  };
  return adapter;
}

/** Removes what must not leave the process from a driver's message. */
const scrub = (text: string, secrets: string[]): string => secrets.filter(Boolean).reduce((out, secret) => out.replaceAll(secret, "***"), text);

/** What the role may do, as one row; every count must be zero and every flag false. */
const ROLE_CHECK = `SELECT
  (SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE c.relkind IN ('r','p','v','m','f','S') AND n.nspname NOT IN ('pg_catalog','information_schema') AND n.nspname NOT LIKE 'pg\\_%'
       AND (has_any_column_privilege(c.oid, 'INSERT,UPDATE') OR has_table_privilege(c.oid, 'INSERT,UPDATE,DELETE,TRUNCATE')))::int AS writable_tables,
  has_database_privilege(current_database(), 'CREATE') AS database_create,
  (SELECT count(*) FROM pg_namespace n WHERE n.nspname NOT IN ('pg_catalog','information_schema') AND n.nspname NOT LIKE 'pg\\_%'
     AND has_schema_privilege(n.oid, 'CREATE'))::int AS creatable_schemas,
  coalesce((SELECT bool_or(r.rolsuper OR r.rolcreaterole OR r.rolcreatedb OR r.rolbypassrls) FROM pg_roles r WHERE pg_has_role(current_user, r.oid, 'member')), true) AS powerful_role,
  coalesce((SELECT bool_or(pg_has_role(current_user, r.oid, 'member')) FROM pg_roles r
     WHERE r.rolname IN ('pg_write_all_data','pg_write_server_files','pg_read_server_files','pg_execute_server_program')), false) AS predefined_role`;

function roleProblems(row: Row): string[] {
  const found: string[] = [];
  if (Number(row.writable_tables) > 0) found.push("it can write to a table");
  if (row.database_create === true || row.database_create === "true") found.push("it can create in the database");
  if (Number(row.creatable_schemas) > 0) found.push("it can create in a schema");
  if (row.powerful_role !== false && row.powerful_role !== "false") found.push("it is a superuser or can create roles or databases");
  if (row.predefined_role === true || row.predefined_role === "true") found.push("it has a role that writes or reads server files");
  return found;
}

/**
 * Opens a table of a Postgres server. The engine makes the only connection, as a read-only attach whose password is
 * a DuckDB secret, before external access is switched off and the configuration locked. The role is checked first.
 */
export async function openServerEngine(source: string, opts: { signal?: AbortSignal; options?: SourceOptions } = {}): Promise<Engine> {
  const options = opts.options ?? serverOptions(source);
  // A Ref's source text and its settings name one table; if they disagree, neither is trusted.
  if (isServerSource(source)) {
    const named = serverOptions(source);
    if (named.conn !== options.conn || named.table !== options.table) throw new FusenError("the source and the settings of this Ref name different tables");
  }
  const { conn, schema, table } = checkOptions(options);
  const profile: Profile = loadProfile(conn);
  if (profile.kind !== "postgres") throw new FusenError(`connection "${conn}" is not a Postgres connection`);
  const password = readPassword(profile);
  const address = await resolveHost(profile);
  const instance = await DuckDBInstance.create(":memory:");
  const connection = await instance.connect();
  const release = () => {
    try {
      connection.closeSync();
    } finally {
      instance.closeSync();
    }
  };
  const probe = async (sql: string): Promise<Row[]> => (await connection.runAndReadAll(sql)).getRowObjectsJson() as Row[];
  const debug = process.env.FUSEN_DEBUG === "1";
  const failed = (what: string, error: unknown): FusenError =>
    new FusenError(`${what} for connection "${conn}"${debug ? `: ${scrub(String(error), [password, profile.host, address, profile.user, profile.dbname])}` : " (FUSEN_DEBUG=1 shows the driver's message)"}`);
  try {
    await connection.run("SET memory_limit='512MB'");
    await connection.run("SET threads=4");
    await connection.run("SET temp_directory=''");
    await connection.run("SET autoinstall_known_extensions=false");
    await connection.run("SET autoload_known_extensions=false");
    try {
      const engine = (await probe("SELECT version() AS v, platform AS p FROM pragma_platform()"))[0]!;
      await connection.run(`LOAD ${lit(bundledExtension("postgres_scanner", String(engine.v), String(engine.p)))}`);
    } catch (error) {
      if (error instanceof FusenError) throw error;
      throw failed("the postgres extension of DuckDB could not be loaded (it is never downloaded while fusenduck runs)", error);
    }
    try {
      // The password lives in a secret, which no catalog function shows; the address is the one that was checked.
      await connection.run(
        `CREATE SECRET fusen_pg (TYPE postgres, HOST ${lit(profile.host)}, PORT ${profile.port}, DATABASE ${lit(profile.dbname)}, USER ${lit(profile.user)}, PASSWORD ${lit(password)})`,
      );
      // libpq fills in whatever the string leaves out from PG* variables of the environment (PGHOST, PGSERVICE, PGOPTIONS,
      // PGSSLROOTCERT ...); the profile alone decides, so they are set aside while the one connection is made.
      const set = Object.entries(process.env).filter(([name]) => /^PG/i.test(name));
      for (const [name] of set) delete process.env[name];
      try {
        await connection.run(
          `ATTACH ${lit(`hostaddr=${address} sslmode=${profile.sslmode} connect_timeout=${CONNECT_TIMEOUT_SECONDS} options='-c statement_timeout=${STATEMENT_TIMEOUT_MS} -c lock_timeout=${STATEMENT_TIMEOUT_MS} -c idle_in_transaction_session_timeout=${STATEMENT_TIMEOUT_MS}'`)} AS pg (TYPE postgres, SECRET fusen_pg, READ_ONLY)`,
        );
      } finally {
        for (const [name, value] of set) process.env[name] = value;
      }
    } catch (error) {
      throw failed("could not connect", error);
    }
    if (opts.signal?.aborted) throw new FusenError("the request was cancelled");
    let problems: string[];
    try {
      problems = roleProblems((await probe(pg(ROLE_CHECK)))[0] ?? {});
    } catch (error) {
      throw failed("could not check the role", error);
    }
    if (problems.length) {
      throw new FusenError(`connection "${conn}": the database role must only be able to read, but ${problems.join(" and ")}. Use a role with SELECT only.`);
    }
    let relation: Relation;
    try {
      const rows = await probe(
        pg(`SELECT c.relkind::text AS kind, c.reltuples::float8::text AS tuples,
              (SELECT string_agg(a.attname, chr(31) ORDER BY k.ord) FROM pg_index i
                 CROSS JOIN LATERAL unnest(i.indkey) WITH ORDINALITY k(attnum, ord)
                 JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = k.attnum
                WHERE i.indrelid = c.oid AND i.indisprimary) AS keys
            FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
            WHERE n.nspname = ${lit(schema)} AND c.relname = ${lit(table)}`),
      );
      const row = rows[0];
      if (!row) throw new FusenError(`connection "${conn}" has no table "${schema}.${table}"`);
      if (row.kind !== "r" && row.kind !== "p") throw new FusenError(`"${schema}.${table}" is not a table (views, materialized views and foreign tables are not supported)`);
      relation = { keys: row.keys ? String(row.keys).split("\u001f") : [], tuples: Number(row.tuples) };
    } catch (error) {
      if (error instanceof FusenError) throw error;
      throw failed("could not read the table", error);
    }
    await connection.run(`CREATE TEMP VIEW data AS SELECT * FROM pg.${ident(schema)}.${ident(table)}`);
    await connection.run("SET enable_external_access=false");
    await connection.run("SET lock_configuration=true");
    if (opts.signal?.aborted) throw new FusenError("the request was cancelled");
    const adapter = serverAdapter({ conn, table: `${schema}.${table}` }, relation);
    return { source: `postgres://${conn}/${schema}.${table}`, files: [], multi: false, adapter, query: createQuery(connection, opts.signal), close: release };
  } catch (error) {
    release();
    throw error;
  }
}
