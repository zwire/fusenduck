#!/usr/bin/env node
// `fusen-tui [file] [--root <dir>]...` : pick rows of a data file in the terminal and copy a Ref. The file is
// a Parquet, CSV, NDJSON or JSON file, a wildcard pattern (quote it), `file.duckdb#table` or `file.sqlite#table`.
// Without a file, the data files under the roots are listed to pick from.
// Files are readable only under the roots (default: the current directory). The Ref last shown is
// printed to stdout when you quit, so `fusen-tui f.parquet | pbcopy` works where OSC 52 does not.
// See docs/adr/0003.
import { parseArgs } from "node:util";
import { describeError, FusenError, logLine } from "@fusenduck/core";
import { View } from "@fusenduck/web/view";
import { mount } from "./mount.ts";
import { plain } from "./text.ts";

function fail(message: string): never {
  process.stderr.write(`fusen-tui: ${plain(message)}\n`);
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
if (extra.length > 0) fail("usage: fusen-tui [file] [--root <dir>]...");
// The screen is drawn on stderr, so stdout can be piped: it gets only the Ref, when you quit.
if (!process.stdin.isTTY || !process.stderr.isTTY) fail("needs a terminal on stdin and stderr; use `fusen peek` or the MCP server in a script");

const roots = parsed.values.root ?? [process.cwd()];
// Every file opened, whether here or from the list, is closed when the program ends.
const views: View[] = [];
let view: View | undefined;
if (file !== undefined) {
  try {
    view = await View.open(file, roots);
    views.push(view);
  } catch (error) {
    if (!(error instanceof FusenError)) process.stderr.write(`fusen-tui: ${plain(logLine(error))}\n`);
    fail(describeError(error));
  }
}

let result: string | undefined;
const app = mount({
    roots,
    ...(view ? { view } : {}),
    track: (opened) => void views.push(opened),
    copy: (text) => process.stderr.write(`\x1b]52;c;${Buffer.from(text).toString("base64")}\x07`),
    done: (ref) => {
      result = ref;
    },
  });

// A closed terminal or a kill stops the running queries (through the unmount) and closes the engine.
const hangup = () => app.unmount();
process.once("SIGHUP", hangup);
process.once("SIGTERM", hangup);

await app.waitUntilExit();
await Promise.all(views.map((v) => v.close()));
if (result !== undefined) process.stdout.write(`${result}\n`);
process.exit(0);
