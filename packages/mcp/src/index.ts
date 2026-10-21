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

function fail(message: string): never {
  process.stderr.write(`fusen-mcp: ${message}\n`);
  process.exit(1);
}

const parse = () =>
  parseArgs({
    strict: true,
    options: {
      root: { type: "string", multiple: true },
      http: { type: "boolean" },
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
    fail(error instanceof Error ? error.message : String(error));
  }
}
