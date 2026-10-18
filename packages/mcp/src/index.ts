#!/usr/bin/env node
// `fusen-mcp [--root <dir>]...` : MCP server over stdio. Files are readable only under the roots
// (default: the current directory). See docs/adr/0001.
import { parseArgs } from "node:util";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createServer } from "./server.ts";

const { values } = parseArgs({ strict: true, options: { root: { type: "string", multiple: true } } });
const server = createServer(values.root ?? [process.cwd()]);
await server.connect(new StdioServerTransport());
