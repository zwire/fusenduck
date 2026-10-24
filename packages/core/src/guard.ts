import { FusenError } from "./errors.ts";
import { lit } from "./sql.ts";
import type { Probe } from "./source.ts";

/**
 * Table functions a query over a database server may call. The scanner functions of the postgres and mysql
 * extensions are not stopped by the lock (`postgres_scan('host=other ...')` still connects), so every function
 * that is not listed here is refused (docs/adr/0005 section 6).
 */
const ALLOWED_TABLE_FUNCTIONS = new Set(["range", "generate_series", "unnest"]);

/** Kinds of table expression a query may use; any other (PIVOT, SHOW, a replacement scan ...) is refused. */
const ALLOWED_TABLE_REFS = new Set(["BASE_TABLE", "TABLE_FUNCTION", "JOIN", "SUBQUERY", "EXPRESSION_LIST", "EMPTY"]);

const refused = (what: string) => new FusenError(`a query over a database may not use ${what}`);

type Node = Record<string, unknown>;
const isNode = (value: unknown): value is Node => typeof value === "object" && value !== null && !Array.isArray(value);

/** Every name a CTE gives, so that a reference to it is not mistaken for a reference to another relation. */
function cteNames(node: unknown, out: Set<string>): void {
  if (Array.isArray(node)) {
    for (const item of node) cteNames(item, out);
  } else if (isNode(node)) {
    const map = node.cte_map;
    if (isNode(map) && Array.isArray(map.map)) for (const entry of map.map) if (isNode(entry) && typeof entry.key === "string") out.add(entry.key);
    for (const value of Object.values(node)) cteNames(value, out);
  }
}

function walk(node: unknown, ctes: Set<string>, relation: string): void {
  if (Array.isArray(node)) {
    for (const item of node) walk(item, ctes, relation);
    return;
  }
  if (!isNode(node)) return;
  const kind = node.type;
  if (node.from_table !== undefined && isNode(node.from_table) && !ALLOWED_TABLE_REFS.has(String(node.from_table.type))) {
    throw refused(`a ${String(node.from_table.type)} table expression`);
  }
  if (kind === "TABLE_FUNCTION") {
    const fn = isNode(node.function) ? node.function : {};
    const name = String(fn.function_name ?? "");
    if (!ALLOWED_TABLE_FUNCTIONS.has(name)) throw refused(`the table function ${name || "(unnamed)"}`);
  } else if (kind === "BASE_TABLE") {
    const table = String(node.table_name ?? "");
    const qualified = node.schema_name || node.catalog_name;
    if (qualified || (table !== relation && !ctes.has(table))) throw refused(`the relation ${qualified ? "in another schema or catalog" : table}`);
  }
  for (const value of Object.values(node)) walk(value, ctes, relation);
}

/**
 * Checks a statement a caller wrote before it reaches an engine that holds a connection to a database server.
 * It must be one SELECT (the parser serializes nothing else), and the whole parse tree is walked: CTEs, subqueries,
 * joins and lateral joins included. Only the relation `relation`, a CTE of the query, and the listed table functions
 * may be named. The engine's own statements do not go through here.
 */
export async function guardServerQuery(sql: string, probe: Probe, relation = "data"): Promise<void> {
  const rows = await probe(`SELECT json_serialize_sql(${lit(sql)}) AS j`);
  let tree: unknown;
  try {
    tree = JSON.parse(String(rows[0]?.j));
  } catch {
    throw new FusenError("the query could not be checked");
  }
  if (!isNode(tree) || tree.error) throw new FusenError("a query over a database must be a single SELECT statement");
  const statements = Array.isArray(tree.statements) ? tree.statements : [];
  if (statements.length !== 1) throw new FusenError("a query over a database must be a single SELECT statement");
  const ctes = new Set<string>();
  cteNames(statements, ctes);
  walk(statements, ctes, relation);
}
