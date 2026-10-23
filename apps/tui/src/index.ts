#!/usr/bin/env node
// `fusen-tui <file.parquet> [--root <dir>]...` : pick rows of a Parquet file in the terminal and copy a Ref.
// Files are readable only under the roots (default: the current directory). The Ref last shown is
// printed to stdout when you quit, so `fusen-tui f.parquet | pbcopy` works where OSC 52 does not.
// See docs/adr/0003.
import { parseArgs } from "node:util";
import { describeError, FusenError, logLine } from "@fusenduck/core";
import { View } from "@fusenduck/web/view";
import { mount } from "./mount.ts";

function fail(message: string): never {
  process.stderr.write(`fusen-tui: ${message}\n`);
  process.exit(1);
}

const parse = () =>
  parseArgs({
    strict: true,
    allowPositionals: true,
    options: { root: { type: "string", multiple: true } },
  });
let parsed: ReturnType<typeof parse>;
try {
  parsed = parse();
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
}
const [file, ...extra] = parsed.positionals;
if (file === undefined || extra.length > 0) fail("usage: fusen-tui <file.parquet> [--root <dir>]...");
if (!process.stdin.isTTY || !process.stdout.isTTY) fail("needs a terminal on stdin and stdout; use `fusen peek` or the MCP server in a script");

let view: View;
try {
  view = await View.open(file, parsed.values.root ?? [process.cwd()]);
} catch (error) {
  if (!(error instanceof FusenError)) process.stderr.write(`fusen-tui: ${logLine(error)}\n`);
  fail(describeError(error));
}

let result: string | undefined;
const app = mount({
    view,
    copy: (text) => process.stdout.write(`\x1b]52;c;${Buffer.from(text).toString("base64")}\x07`),
    done: (ref) => {
      result = ref;
    },
  });

// A closed terminal or a kill stops the running queries (through the unmount) and closes the engine.
const hangup = () => app.unmount();
process.once("SIGHUP", hangup);
process.once("SIGTERM", hangup);

await app.waitUntilExit();
await view.close();
if (result !== undefined) process.stdout.write(`${result}\n`);
process.exit(0);
