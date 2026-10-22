#!/usr/bin/env node
// `fusen-web [--root <dir>]... [--host <loopback>] [--port <n>]` : the Web UI on a loopback address.
// Prints a URL with a one-time code (valid 60 seconds) to stderr. Files are readable only under the
// roots (default: the current directory). See docs/adr/0002.
import { parseArgs } from "node:util";
import { startWebServer } from "./server.ts";

function fail(message: string): never {
  process.stderr.write(`fusen-web: ${message}\n`);
  process.exit(1);
}

const parse = () =>
  parseArgs({
    strict: true,
    options: {
      root: { type: "string", multiple: true },
      host: { type: "string" },
      port: { type: "string" },
    },
  });
let values: ReturnType<typeof parse>["values"];
try {
  ({ values } = parse());
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
}
const port = values.port === undefined ? 0 : Number(values.port);
if (!/^\d+$/.test(values.port ?? "0") || port > 65535) fail("--port must be an integer from 0 to 65535");

try {
  const handle = await startWebServer({ roots: values.root ?? [process.cwd()], port, ...(values.host === undefined ? {} : { host: values.host }) });
  process.stderr.write(`fusen-web: open this URL within 60 seconds (it works once): ${handle.url}\n`);
  const stop = () => void handle.close().then(() => process.exit(0));
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
}
