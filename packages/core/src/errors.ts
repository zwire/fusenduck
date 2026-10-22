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
    // "region = south" names a column south; the fix is quoting the value.
    const hint = /^Binder Error: Referenced column ".*" not found/.test(message) ? " A text value goes in single quotes, as in region = 'south'." : "";
    throw new FusenError(`${what} rejected: ${message.slice(0, 300)}${hint}`);
  }
}
