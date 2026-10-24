/** SQL quoting helpers, shared by the engine and the source adapters. */
/** A SQL string literal. */
export function lit(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

/** A SQL identifier. */
export function ident(name: string): string {
  return `"${name.replaceAll('"', '""')}"`;
}
