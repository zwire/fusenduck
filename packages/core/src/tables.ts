import { loadProfile } from "./connections.ts";
import { FusenError } from "./errors.ts";
import { listMysqlTables } from "./mysql.ts";
import { CONNECTION, listServerTables } from "./server.ts";

/** `postgres://name/` or `mysql://name/`: a connection without a table, which is asked for its list of tables. */
const CONNECTION_ONLY = /^(postgres|mysql):\/\/([^/]*)\/?$/;

export const isConnectionSource = (source: string): boolean => CONNECTION_ONLY.test(source);

/** The tables a connection of connections.toml offers, as the names a source takes after `kind://name/`. */
export async function listTables(source: string, signal?: AbortSignal): Promise<{ tables: string[]; truncated: boolean }> {
  const [, kind, conn = ""] = CONNECTION_ONLY.exec(source) ?? [];
  if (!kind || !CONNECTION.test(conn)) throw new FusenError("give a connection as postgres://name/ or mysql://name/");
  if (loadProfile(conn).kind !== kind) throw new FusenError(`connection "${conn}" is not a ${kind === "mysql" ? "MySQL" : "Postgres"} connection`);
  return kind === "mysql" ? listMysqlTables(conn, signal) : listServerTables(conn, signal);
}
