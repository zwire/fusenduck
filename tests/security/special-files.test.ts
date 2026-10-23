import { execFileSync } from "node:child_process";
import { closeSync, constants, mkdirSync, openSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { mintRef, openSource, peek } from "@fusenduck/core";
import { View } from "../../apps/web/src/view.ts";
import { tempDir } from "../helpers/fixtures.ts";

// A source must be a regular file. A FIFO (named pipe) blocks whoever opens it until something
// writes to it, inside DuckDB, where neither the clock nor an interrupt reaches: the call never
// returns, the process cannot exit, and over MCP each such call holds a slot of the server for good.
// Anyone who can put a file under a root (an unpacked archive, a shared folder) can make one.

const settle = (work: Promise<unknown>, ms = 3000) =>
  Promise.race([work.then(() => "opened", (e: unknown) => `refused: ${(e as Error).message}`), new Promise<string>((r) => setTimeout(() => r("hung"), ms))]);

describe.skipIf(process.platform === "win32")("a source that is not a regular file", () => {
  const dir = tempDir();
  const fifo = join(dir, "pipe.parquet");
  const folder = join(dir, "folder.parquet");

  beforeAll(() => {
    execFileSync("mkfifo", [fifo]);
    mkdirSync(folder);
  });

  // Releases a reader left blocked on the FIFO (when the guard is missing), so the run can end.
  afterEach(() => {
    try {
      closeSync(openSync(fifo, constants.O_WRONLY | constants.O_NONBLOCK));
    } catch {
      // No reader is waiting.
    }
  });

  it.each([
    ["openSource", () => openSource(fifo, { roots: [dir] })],
    ["mintRef (fusen_ref, fusen ref)", () => mintRef(fifo, { roots: [dir] })],
    ["peek (fusen_peek, fusen peek)", () => peek(fifo, { roots: [dir] })],
    ["the Web UI and the VS Code extension (View.open)", () => View.open(fifo, [dir])],
  ])("a FIFO is refused at once by %s, with the message a missing file gets", async (_name, open) => {
    expect(await settle(open())).toBe(`refused: the source is not readable or is outside the allowed roots: ${fifo}`);
  });

  it("a FIFO is refused without roots too", async () => {
    expect(await settle(openSource(fifo))).toBe(`refused: cannot read ${fifo}: there is no such file, or it is not readable`);
  });

  it("a folder named like a Parquet file is refused the same way", async () => {
    expect(await settle(openSource(folder, { roots: [dir] }))).toBe(`refused: the source is not readable or is outside the allowed roots: ${folder}`);
  });
});
