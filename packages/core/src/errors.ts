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
