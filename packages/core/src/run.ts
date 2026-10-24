import type { DuckDBConnection } from "@duckdb/node-api";
import { FusenError } from "./errors.ts";

export type Row = Record<string, unknown>;

/**
 * The function an engine answers `query` with: one statement on a clock, stopped when the caller goes away.
 * `release` frees whatever a stopped read may be blocked on (a pipe); a source with nothing of the kind passes nothing.
 */
export function createQuery(
  connection: DuckDBConnection,
  signal: AbortSignal | undefined,
  release: () => void = () => {},
): (sql: string, opts?: { timeoutMs?: number; signal?: AbortSignal }) => Promise<Row[]> {
  const cancelled = () => new FusenError("the request was cancelled");
  return async (sql, opts = {}) => {
    // The caller of one query (a request of the Web UI) may go away while the engine lives on.
    const signals = [signal, opts.signal].filter((s): s is AbortSignal => s !== undefined);
    const gone = () => signals.some((s) => s.aborted);
    // A predicate is untrusted SQL and can be slow without reading many bytes; stop it on a clock.
    if (gone()) throw cancelled();
    // The file is read again by every query, so it may have turned into a FIFO since it was opened;
    // an interrupt does not reach a blocked open, so the pipe is released as well.
    const interrupt = () => {
      connection.interrupt();
      release();
    };
    let timedOut = false;
    // An interrupt that lands before DuckDB has started the query is dropped, and a pipe released
    // before the open began frees nothing, so both repeat until the query ends.
    let repeat: ReturnType<typeof setInterval> | undefined;
    const stop = () => {
      interrupt();
      repeat ??= setInterval(interrupt, 25);
    };
    const timer = opts.timeoutMs
      ? setTimeout(() => {
          timedOut = true;
          stop();
        }, opts.timeoutMs)
      : undefined;
    // A caller that goes away (a closed connection, a cancelled tool call) stops the running query.
    for (const s of signals) s.addEventListener("abort", stop, { once: true });
    try {
      const reader = await connection.runAndReadAll(sql);
      return reader.getRowObjectsJson() as Row[];
    } catch (error) {
      if (gone()) throw cancelled();
      // A released pipe fails the read with another message than an interrupt does.
      if (timedOut || (timer && /interrupt/i.test(String(error)))) throw new FusenError(`query stopped after ${opts.timeoutMs} ms`);
      throw error;
    } finally {
      clearTimeout(timer);
      clearInterval(repeat);
      for (const s of signals) s.removeEventListener("abort", stop);
    }
  };
}
