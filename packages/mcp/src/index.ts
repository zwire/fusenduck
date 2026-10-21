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

const { values } = parseArgs({
  strict: true,
  options: {
    root: { type: "string", multiple: true },
    http: { type: "boolean" },
    host: { type: "string" },
    port: { type: "string" },
  },
});
const roots = values.root ?? [process.cwd()];

if (!values.http) {
  if (values.host !== undefined || values.port !== undefined) {
    process.stderr.write("fusen-mcp: --host and --port need --http\n");
    process.exit(1);
  }
  await createServer(roots).connect(new StdioServerTransport());
} else {
  const port = values.port === undefined ? 7457 : Number(values.port);
  if (!/^\d+$/.test(values.port ?? "0") || port > 65535) {
    process.stderr.write("fusen-mcp: --port must be an integer from 0 to 65535\n");
    process.exit(1);
  }
  const given = process.env.FUSEN_MCP_TOKEN;
  const token = given || randomBytes(24).toString("base64url");
  try {
    const { url } = await startHttpServer({ roots, token, port, ...(values.host === undefined ? {} : { host: values.host }) });
    process.stderr.write(`fusen-mcp: listening on ${url}\n`);
    if (!given) process.stderr.write(`fusen-mcp: token (send as "Authorization: Bearer <token>"): ${token}\n`);
  } catch (error) {
    process.stderr.write(`fusen-mcp: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  }
}
