import { createHash } from "node:crypto";
import { DuckDBInstance } from "@duckdb/node-api";
import { loadProfile, readPassword, resolveHost, type Profile } from "./connections.ts";
import type { Engine } from "./engine.ts";
import { bundledExtension } from "./extensions.ts";
import { FusenError } from "./errors.ts";
import { createQuery, type Row } from "./run.ts";
import { BOUNDARY_ROWS, CONNECTION, EXACT_COUNT_MAX, SAMPLE_ROWS, scrub, serverOptions } from "./server.ts";
import { ident, lit } from "./sql.ts";
import type { SourceAdapter, SourceOptions } from "./source.ts";

/**
 * A table of a MySQL server (docs/adr/0005), named `mysql://<connection>/<table>` in the database the connection names.
 * It has the shape of the Postgres source (server.ts): one read-only attach made before the lock, a SELECT-only role,
 * a Ref that carries the connection's name and never an address or a password.
 */
const PART = /^[^`"'\\\0*?./ ][^`"'\\\0*?./]{0,63}$/;

/** A MySQL identifier. */
const my = (name: string): string => `\`${name.replaceAll("`", "``")}\``;

function checkOptions(options: SourceOptions): { conn: string; table: string } {
  const keys = Object.keys(options);
  if (keys.some((k) => k !== "conn" && k !== "table")) throw new FusenError("a database source takes only opt.conn and opt.table");
  const { conn, table } = options;
  if (!conn || !CONNECTION.test(conn)) throw new FusenError("opt.conn must be the name of a connection");
  if (!table || !PART.test(table) || table.endsWith(" ")) throw new FusenError("opt.table must be a table name, without dots, quotes or slashes");
  return { conn, table };
}

interface Relation {
  /** Primary key columns, in order. Empty when the table has none, and rows are then not selectable. */
  keys: string[];
  columns: string[];
  /** Whether the first key column is a whole number, so key-range boundaries can be worked out. */
  integerKey: boolean;
  tuples: number;
}

const ONE = (sql: string): string => `SELECT * FROM mysql_query('my', ${lit(sql)})`;

export function mysqlAdapter(options: SourceOptions, relation?: Relation): SourceAdapter {
  const { table } = checkOptions(options);
  const stored = my(table);
  const adapter: SourceAdapter = {
    name: "mysql",
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
      if (withPosition) throw new FusenError("rows of a database table are selected by its key column, such as where id = 5, not by position");
      return "SELECT * FROM data";
    },
    async fingerprint(engine) {
      const keys = relation?.keys ?? [];
      const columns = relation?.columns ?? [];
      const exact = (relation?.tuples ?? 0) <= EXACT_COUNT_MAX;
      const order = keys.map(my).join(", ");
      const orderDesc = keys.map((k) => `${my(k)} DESC`).join(", ");
      const rowJson = `json_object(${columns.flatMap((c) => [lit(c), my(c)]).join(", ")})`;
      // The rows of a sample are combined order-independently (xor and sum of a 60-bit piece of each row's md5), so no
      // group_concat length limit can cut a sample short.
      const sample = (from: string) =>
        `(select concat_ws(':', count(*), bit_xor(h), sum(h)) from (select cast(conv(substr(md5(${rowJson}), 1, 15), 16, 10) as unsigned) as h from (${from}) r) s)`;
      const edge = (direction: string, rows: number) => (keys.length && columns.length ? sample(`select * from ${stored} order by ${keys.map((k) => `${my(k)} ${direction}`).join(", ")} limit ${rows}`) : "''");
      const first = keys[0] ? my(keys[0]) : "";
      const boundary = (i: number) =>
        sample(`select * from ${stored} where ${first} >= (select cast(floor(min(${first}) + (max(${first}) - min(${first})) * ${i} / 4) as signed) from ${stored}) order by ${order} limit ${BOUNDARY_ROWS}`);
      const middle = relation?.integerKey && columns.length ? [1, 2, 3].map(boundary) : [];
      const sql = `select ${exact ? `(select count(*) from ${stored})` : "(select table_rows from information_schema.tables where table_schema = database() and table_name = " + lit(table) + ")"} as n,
        ${keys.length ? `(select json_array(${keys.map(my).join(", ")}) from ${stored} order by ${orderDesc} limit 1)` : "''"} as maxkey,
        (select group_concat(column_name, ':', column_type, ':', is_nullable order by ordinal_position separator ',') from information_schema.columns where table_schema = database() and table_name = ${lit(table)}) as cols,
        ${edge("asc", SAMPLE_ROWS)} as head, ${edge("desc", SAMPLE_ROWS)} as tail, ${middle.length ? `concat_ws('|', ${middle.join(", ")})` : "''"} as mid,
        database() as db, @@server_uuid as sys`;
      // One statement, so the count, the key and the samples come from one snapshot (the attach is a READ ONLY transaction).
      const row = (await engine.query(ONE(sql)))[0] ?? {};
      return createHash("sha256")
        .update(`mysql:${exact ? "exact" : "estimate"}:${["n", "maxkey", "cols", "head", "tail", "mid", "db", "sys"].map((k) => String(row[k])).join(":")}`)
        .digest("hex")
        .slice(0, 12);
    },
    async scanBytes(engine) {
      const row = (await engine.query(ONE(`select data_length + index_length as bytes from information_schema.tables where table_schema = database() and table_name = ${lit(table)}`)))[0];
      return Number(row?.bytes ?? 0);
    },
  };
  return adapter;
}

/**
 * What the role may do, from the privilege tables a user can read about itself (SHOW GRANTS cannot be run through the
 * extension). Every row must be a plain SELECT; no role may be active, because information_schema does not list a role's grants.
 */
const ROLE_CHECK = `select
  (select count(*) from information_schema.user_privileges where privilege_type <> 'USAGE' or is_grantable <> 'NO') as global_privileges,
  (select count(*) from information_schema.schema_privileges where privilege_type <> 'SELECT' or is_grantable <> 'NO') as schema_privileges,
  (select count(*) from information_schema.table_privileges where privilege_type <> 'SELECT' or is_grantable <> 'NO') as table_privileges,
  (select count(*) from information_schema.column_privileges where privilege_type <> 'SELECT' or is_grantable <> 'NO') as column_privileges,
  current_role() as active_role`;

export function roleProblems(row: Row): string[] {
  const found: string[] = [];
  if (Number(row.global_privileges) > 0) found.push("it has a privilege on the whole server");
  if (Number(row.schema_privileges) > 0) found.push("it has more than SELECT on a database");
  if (Number(row.table_privileges) > 0 || Number(row.column_privileges) > 0) found.push("it has more than SELECT on a table or column");
  if (String(row.active_role ?? "NONE") !== "NONE") found.push("it has a role active, whose grants cannot be checked");
  return found;
}

/**
 * Opens a table of a MySQL server. The engine makes the only connection, as a read-only attach whose password is a
 * DuckDB secret, before external access is switched off and the configuration locked (a new ATTACH is refused after that).
 */
export async function openMysqlEngine(source: string, opts: { signal?: AbortSignal; options?: SourceOptions } = {}): Promise<Engine> {
  const options = opts.options ?? serverOptions(source);
  if (/^mysql:\/\//.test(source)) {
    const named = serverOptions(source);
    if (named.conn !== options.conn || named.table !== options.table) throw new FusenError("the source and the settings of this Ref name different tables");
  }
  const { conn, table } = checkOptions(options);
  const profile: Profile = loadProfile(conn);
  if (profile.kind !== "mysql") throw new FusenError(`connection "${conn}" is not a MySQL connection`);
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
    new FusenError(`${what} for connection "${conn}"${debug ? `: ${scrub(String(error), [password, profile.host, address, profile.user, profile.dbname, profile.sslCa ?? ""])}` : " (FUSEN_DEBUG=1 shows the driver's message)"}`);
  const server = (sql: string) => probe(ONE(sql));
  try {
    await connection.run("SET memory_limit='512MB'");
    await connection.run("SET threads=4");
    await connection.run("SET temp_directory=''");
    await connection.run("SET autoinstall_known_extensions=false");
    await connection.run("SET autoload_known_extensions=false");
    try {
      const engine = (await probe("SELECT version() AS v, platform AS p FROM pragma_platform()"))[0]!;
      await connection.run(`LOAD ${lit(bundledExtension("mysql_scanner", String(engine.v), String(engine.p)))}`);
    } catch (error) {
      if (error instanceof FusenError) throw error;
      throw failed("the mysql extension of DuckDB could not be loaded (it is never downloaded while fusenduck runs)", error);
    }
    try {
      // The password lives in a secret, which no catalog function shows; the address is the one that was checked.
      await connection.run(
        `CREATE SECRET fusen_my (TYPE mysql, HOST ${lit(address)}, PORT ${profile.port}, DATABASE ${lit(profile.dbname)}, USER ${lit(profile.user)}, PASSWORD ${lit(password)}, SSL_MODE ${lit(profile.sslmode)}${profile.sslCa ? `, SSL_CA ${lit(profile.sslCa)}` : ""})`,
      );
      // The client library may read MYSQL_* variables; the profile alone decides, so they are set aside for the one connection.
      const set = Object.entries(process.env).filter(([name]) => /^MYSQL_/i.test(name));
      for (const [name] of set) delete process.env[name];
      try {
        await connection.run("ATTACH '' AS my (TYPE mysql, SECRET fusen_my, READ_ONLY)");
      } finally {
        for (const [name, value] of set) process.env[name] = value;
      }
    } catch (error) {
      throw failed("could not connect", error);
    }
    if (opts.signal?.aborted) throw new FusenError("the request was cancelled");
    let problems: string[];
    try {
      problems = roleProblems((await server(ROLE_CHECK))[0] ?? {});
    } catch (error) {
      throw failed("could not check the role", error);
    }
    if (problems.length) {
      throw new FusenError(`connection "${conn}": the database role must only be able to read, but ${problems.join(" and ")}. Use a role with SELECT only.`);
    }
    let relation: Relation;
    try {
      const rows = await server(
        `select t.table_type as kind, t.table_rows as tuples, t.table_name as name,
           (select group_concat(s.column_name order by s.seq_in_index separator '\u001f') from information_schema.statistics s
             where s.table_schema = t.table_schema and s.table_name = t.table_name and s.index_name = 'PRIMARY') as pk,
           (select group_concat(c.column_name order by c.ordinal_position separator '\u001f') from information_schema.columns c
             where c.table_schema = t.table_schema and c.table_name = t.table_name) as cols,
           (select c.data_type in ('tinyint', 'smallint', 'mediumint', 'int', 'bigint') from information_schema.statistics s
              join information_schema.columns c on c.table_schema = s.table_schema and c.table_name = s.table_name and c.column_name = s.column_name
             where s.table_schema = t.table_schema and s.table_name = t.table_name and s.index_name = 'PRIMARY' and s.seq_in_index = 1) as integer_key
         from information_schema.tables t where t.table_schema = database() and binary t.table_name = binary ${lit(table)}`,
      );
      const row = rows[0];
      if (!row) throw new FusenError(`connection "${conn}" has no table "${table}"`);
      if (String(row.cols ?? "").split("\u001f").some((c) => /[`'"\\\0]/.test(c))) throw new FusenError(`"${table}" has a column whose name holds a quote or a backslash, which is not supported`);
      if (row.kind !== "BASE TABLE") throw new FusenError(`"${table}" is not a table (views and system tables are not supported)`);
      relation = {
        keys: row.pk ? String(row.pk).split("\u001f") : [],
        columns: row.cols ? String(row.cols).split("\u001f") : [],
        integerKey: row.integer_key === true || row.integer_key === "true" || String(row.integer_key) === "1",
        tuples: Number(row.tuples),
      };
    } catch (error) {
      if (error instanceof FusenError) throw error;
      throw failed("could not read the table", error);
    }
    await connection.run(`CREATE TEMP VIEW data AS SELECT * FROM my.${ident(table)}`);
    await connection.run("SET enable_external_access=false");
    await connection.run("SET lock_configuration=true");
    if (opts.signal?.aborted) throw new FusenError("the request was cancelled");
    const adapter = mysqlAdapter({ conn, table }, relation);
    return { source: `mysql://${conn}/${table}`, files: [], multi: false, adapter, query: createQuery(connection, opts.signal), close: release };
  } catch (error) {
    release();
    throw error;
  }
}
