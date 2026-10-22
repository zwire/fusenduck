#!/usr/bin/env node
// `fusen-mcp [--root <dir>]... [--http [--host <loopback>] [--port <n>]]` : MCP server over stdio,
// or over Streamable HTTP on a loopback address with a bearer token (FUSEN_MCP_TOKEN, or one
// generated and printed to stderr). Files are readable only under the roots (default: the current
// directory). See docs/adr/0001.
import { randomBytes } from "node:crypto";
import { parseArgs } from "node:util";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { startHttpServer } from "./http.ts";
import { createServer } from "./server.ts";

const USAGE = `usage: fusen-mcp [--root <dir>]... [--http [--host <loopback>] [--port <n>]]
  stdio by default; --http serves Streamable HTTP on 127.0.0.1:7457/mcp with a bearer token
  (FUSEN_MCP_TOKEN, or one generated and printed here). Roots default to the current directory.`;

/** A wrong command line exits 2 with the usage; a server that could not start exits 1. */
function fail(message: string, status = 2): never {
  process.stderr.write(`fusen-mcp: ${message}\n${status === 2 ? `${USAGE}\n` : ""}`);
  process.exit(status);
}

const parse = () =>
  parseArgs({
    strict: true,
    options: {
      root: { type: "string", multiple: true },
      http: { type: "boolean" },
      host: { type: "string" },
      port: { type: "string" },
      help: { type: "boolean", short: "h" },
    },
  });
let values: ReturnType<typeof parse>["values"];
try {
  ({ values } = parse());
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
}
if (values.help) {
  process.stdout.write(`${USAGE}\n`);
  process.exit(0);
}
const roots = values.root ?? [process.cwd()];

if (!values.http) {
  if (values.host !== undefined || values.port !== undefined) {
    fail("--host and --port need --http");
  }
  await createServer(roots).connect(new StdioServerTransport());
} else {
  const port = values.port === undefined ? 7457 : Number(values.port);
  if (!/^\d+$/.test(values.port ?? "0") || port > 65535) {
    fail("--port must be an integer from 0 to 65535");
  }
  const given = process.env.FUSEN_MCP_TOKEN;
  const token = given || randomBytes(24).toString("base64url");
  try {
    const { url } = await startHttpServer({ roots, token, port, ...(values.host === undefined ? {} : { host: values.host }) });
    process.stderr.write(`fusen-mcp: listening on ${url}\n`);
    if (!given) process.stderr.write(`fusen-mcp: token (send as "Authorization: Bearer <token>"): ${token}\n`);
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error), 1);
  }
}
