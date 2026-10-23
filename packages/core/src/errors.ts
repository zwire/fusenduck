/**
 * An error whose message core built itself, from the caller's own input (a bad Ref, a predicate
 * that was rejected, a path outside the roots). Safe to show to an agent.
 *
 * Anything else that reaches a boundary is an engine error, and DuckDB puts source values into its
 * messages (a failed cast or error() quotes the cell). Those are withheld; see describeError.
 */
export class FusenError extends Error {}

const WITHHELD =
  "the engine could not run this query. Details are withheld because they can contain values from the source.";

/** The message a client (an agent or a person) may see for an error. */
export function describeError(error: unknown, opts: { debug?: boolean } = {}): string {
  if (error instanceof FusenError) return error.message;
  if (opts.debug) return error instanceof Error ? error.message : String(error);
  return WITHHELD;
}

/**
 * The line a server writes to its own log for an error it did not expect. The log is kept (an MCP
 * host saves the server's stderr to files, VS Code shows the Output panel), so an engine message,
 * which can quote cell values, is cut to its kind ("Conversion Error"), with the JavaScript frames
 * it was thrown from (DuckDB's own errors carry none).
 * FUSEN_DEBUG=1 logs the whole error, as the CLI shows it.
 */
export function logLine(error: unknown, opts: { debug?: boolean } = {}): string {
  const debug = opts.debug ?? process.env.FUSEN_DEBUG === "1";
  if (!(error instanceof Error)) return debug ? String(error) : `${typeof error} thrown (FUSEN_DEBUG=1 shows it)`;
  if (debug) return error.stack ?? `${error.name}: ${error.message}`;
  const kind = /^([A-Za-z][A-Za-z ]{0,40} Error):/.exec(error.message)?.[1] ?? "message withheld";
  // The stack starts with the message, which can span lines that look like frames (a cell with
  // "\n    at ..."), so frames are read only after it; when it is not there, none are.
  const header = `${error.name}: ${error.message}`;
  const stack = error.stack ?? "";
  const frames = stack.startsWith(header) ? stack.slice(header.length).split("\n").filter((line) => /^\s+at /.test(line)) : [];
  return [`${error.name}: ${kind} (FUSEN_DEBUG=1 shows the message, which can quote values from the source)`, ...frames].join("\n");
}

/**
 * Runs the planning of a selection the caller wrote (`DESCRIBE`, which reads no rows). A parser,
 * binder or catalog error is about the caller's own text and the schema, never a cell, so its first
 * line is shown: a misspelled column or an unquoted text value is then something the caller can fix.
 * Any other error stays withheld.
 */
export async function planned<T>(what: string, plan: () => Promise<T>): Promise<T> {
  try {
    return await plan();
  } catch (error) {
    if (error instanceof FusenError) throw error;
    const message = (error instanceof Error ? error.message : String(error)).split("\n")[0]!;
    if (!/^(Parser|Binder|Catalog) Error:/.test(message)) throw error;
    // "region = south" names a column south; the fix may be quoting the value, or the name is misspelled.
    const missing = /^Binder Error: Referenced column "(.*)" not found/.exec(message)?.[1];
    const hint = missing === undefined ? "" : ` If ${missing} is a text value, put it in single quotes: '${missing.replaceAll("'", "''")}'.`;
    throw new FusenError(`${what} rejected: ${message.slice(0, 300)}${hint}`);
  }
}
