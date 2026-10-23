import { execFileSync } from "node:child_process";
import { closeSync, constants, openSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DuckDBInstance } from "@duckdb/node-api";
import { openSource } from "@fusenduck/core";
import { lit, watchOpen } from "../../packages/core/src/engine.ts";
import { startWebServer } from "../../apps/web/src/server.ts";
import { tempDir, writeCustomers } from "../helpers/fixtures.ts";
import { buildSpa, call } from "../helpers/web.ts";

// The checks that a source is a regular file happen once, when it is opened. The file is read again by
// every query, so whoever can write to the folder can swap it for a FIFO afterwards. Opening a FIFO
// blocks inside DuckDB, where an interrupt does not reach, so the clock and a closed connection
// must release the open themselves.

const settle = (work: Promise<unknown>, ms = 4000) =>
  Promise.race([work.then(() => "done", (e: unknown) => `refused: ${(e as Error).message}`), new Promise<string>((r) => setTimeout(() => r("hung"), ms))]);

describe.skipIf(process.platform === "win32")("a file swapped for a FIFO after it was opened", () => {
  const dir = tempDir();
  let file = "";
  let fifo = "";
  let n = 0;
  beforeEach(() => {
    file = join(dir, `swapped-${++n}.parquet`);
  });

  // Frees a reader left blocked on the FIFO (when the guard is missing), so the run can end.
  afterEach(() => {
    try {
      closeSync(openSync(fifo, constants.O_WRONLY | constants.O_NONBLOCK));
    } catch {
      // No reader is waiting.
    }
  });

  async function openThenSwap() {
    await writeCustomers(file, 100);
    const engine = await openSource(file, { roots: [dir] });
    unlinkSync(file);
    execFileSync("mkfifo", [file]);
    fifo = file;
    return engine;
  }

  it("the query's clock stops it", async () => {
    const engine = await openThenSwap();
    const result = await settle(engine.query("SELECT count(*) FROM data", { timeoutMs: 500 }));
    expect(result).toMatch(/^refused: /);
    engine.close();
  });

  it("a cancelled caller stops it", async () => {
    const engine = await openThenSwap();
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 300);
    const result = await settle(engine.query("SELECT count(*) FROM data", { signal: controller.signal }));
    expect(result).toBe("refused: the request was cancelled");
    engine.close();
  });

  it("an open that finds a FIFO where the file was gives up (watchOpen)", async () => {
    // The regular-file check ran earlier; this is the DuckDB open that follows it.
    execFileSync("mkfifo", [file]);
    fifo = file;
    const connection = await (await DuckDBInstance.create(":memory:")).connect();
    const result = await settle(watchOpen(file, connection.run(`CREATE VIEW data AS SELECT * FROM read_parquet(${lit(file)})`), 500));
    expect(result).toMatch(/^refused: the source did not open within 500 ms/);
  });
});

describe("the Web UI stops a query when its caller hangs up", () => {
  const dir = tempDir();
  const file = join(dir, "big.parquet");

  it("a closed connection interrupts the running filter well before its clock", async () => {
    buildSpa();
    await writeCustomers(file, 2000);
    const handle = await startWebServer({ roots: [dir] });
    try {
      const base = new URL(handle.url).origin;
      const token = String((await call(base, "/api/session", { code: new URL(handle.url).hash.replace("#c=", "") })).body.token);
      const opened = (await call(base, "/api/open", { path: file }, { token })).body as { source: string; fingerprint: string };
      // A filter that runs for many seconds without reading a table: a list of millions built for every row.
      const slow = "len(list_filter(range(8000000), x -> x % 7 = id)) >= 0";
      const controller = new AbortController();
      const started = Date.now();
      const pending = fetch(new URL("/api/rows", base), {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
        body: JSON.stringify({ source: opened.source, fingerprint: opened.fingerprint, offset: 0, limit: 10, where: slow }),
        signal: controller.signal,
      }).catch(() => undefined);
      setTimeout(() => controller.abort(), 700);
      await pending;
      // The next request waits behind the running one on the engine's single connection.
      const next = await call(base, "/api/rows", { source: opened.source, fingerprint: opened.fingerprint, offset: 0, limit: 5 }, { token });
      expect(next.status).toBe(200);
      expect(Date.now() - started).toBeLessThan(4000);
    } finally {
      await handle.close();
    }
  }, 30_000);
});
