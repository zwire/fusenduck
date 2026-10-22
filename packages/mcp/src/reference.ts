// The MCP tool reference (docs/reference/mcp-tools.md), generated from the tool schemas the server
// registers, so the page cannot drift from what an agent is offered. tests/unit/reference.test.ts
// fails when the page is out of date.
// Run: node packages/mcp/src/reference.ts --write   (pnpm docs:reference)
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "./server.ts";

export const REFERENCE_PATH = join(import.meta.dirname, "../../../docs/reference/mcp-tools.md");

interface Property {
  type?: string;
  description?: string;
  minimum?: number;
  maximum?: number;
  minLength?: number;
  minItems?: number;
  items?: Property;
}

const cell = (text: string) => text.replaceAll("|", "\\|").replaceAll("\n", " ");

function typeOf(p: Property): string {
  const base = p.type === "array" ? `${p.items?.type ?? "unknown"}[]` : (p.type ?? "unknown");
  const bounds = [
    p.minimum !== undefined && p.maximum !== undefined ? `${p.minimum} to ${p.maximum}` : "",
    p.minimum !== undefined && p.maximum === undefined ? `at least ${p.minimum}` : "",
    p.minLength ? "not empty" : "",
    p.minItems ? `at least ${p.minItems} item${p.minItems > 1 ? "s" : ""}` : "",
    p.items?.minLength ? "items not empty" : "",
  ].filter(Boolean);
  return bounds.length ? `${base} (${bounds.join(", ")})` : base;
}

/** The reference page, as Markdown. */
export async function renderReference(): Promise<string> {
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const server = createServer([]);
  await server.connect(serverSide);
  const client = new Client({ name: "reference", version: "0.0.0" });
  await client.connect(clientSide);
  try {
    const { tools } = await client.listTools();
    const lines = [
      "# MCP tools",
      "",
      "<!-- Generated from the tool schemas in packages/mcp/src/server.ts by `pnpm docs:reference`. Do not edit by hand. -->",
      "",
      "`fusen-mcp` offers these tools. Paths must lie under a root given with `--root` (default: the directory the server started in).",
      "A failed call is a tool error whose text starts with `fusen error:`; engine errors that can quote values from the file are withheld.",
      "The text of a result (the `FUSEN_RESULT` block) is fixed by the golden tests in `tests/contract/render.test.ts`,",
      "and the Ref strings by the frozen corpus in `tests/contract/refs`. See [the guide](../guide.md) for how to use them.",
      "",
    ];
    for (const tool of [...tools].sort((a, b) => a.name.localeCompare(b.name))) {
      const schema = tool.inputSchema as { properties?: Record<string, Property>; required?: string[] };
      lines.push(`## ${tool.name}`, "", tool.description ?? "", "", "| Argument | Type | Required | Description |", "|---|---|---|---|");
      for (const [name, p] of Object.entries(schema.properties ?? {})) {
        const required = schema.required?.includes(name) ? "yes" : "no";
        lines.push(`| \`${name}\` | ${cell(typeOf(p))} | ${required} | ${cell(p.description ?? "")} |`);
      }
      lines.push("");
    }
    return lines.join("\n");
  } finally {
    await client.close();
    await server.close();
  }
}

if (import.meta.main && process.argv.includes("--write")) {
  writeFileSync(REFERENCE_PATH, await renderReference());
  process.stdout.write(`wrote ${REFERENCE_PATH}\n`);
}
