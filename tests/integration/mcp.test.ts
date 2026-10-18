import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { HOSTILE_NOTE, tempDir, writeCustomers } from "../helpers/fixtures.ts";

const server = join(import.meta.dirname, "../../packages/mcp/src/index.ts");

describe("MCP adapter over stdio", () => {
  const dir = tempDir();
  const file = join(dir, "customers.parquet");
  const outside = join(tempDir(), "outside.parquet");
  let client: Client;

  const call = async (name: string, args: Record<string, unknown>) => {
    const result = await client.callTool({ name, arguments: args });
    const content = result.content as { type: string; text: string }[];
    return { isError: result.isError === true, text: content.map((c) => c.text).join("\n") };
  };

  beforeAll(async () => {
    await writeCustomers(file, 1000);
    await writeCustomers(outside, 10);
    client = new Client({ name: "test", version: "0.0.0" });
    await client.connect(new StdioClientTransport({ command: "node", args: [server, "--root", dir] }));
  });

  afterAll(async () => {
    await client.close();
  });

  it("lists the three tools, with descriptions that carry no data", async () => {
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(["fusen_card", "fusen_ref", "fusen_resolve"]);
    for (const t of tools) expect(t.description).not.toContain(HOSTILE_NOTE);
  });

  it("card, ref and resolve run end to end and return the selected rows", async () => {
    const card = await call("fusen_card", { path: file });
    expect(card.isError).toBe(false);
    expect(card.text).toContain("rows: 1000");

    const ref = (await call("fusen_ref", { path: file, where: "region = 'south'" })).text;
    expect(ref).toMatch(/^fusen:\/\//);
    const out = await call("fusen_resolve", { ref, limit: 1000 });
    expect(out.isError).toBe(false);
    const rows = out.text.split("\n").filter((l) => l.startsWith("{"));
    expect(rows).toHaveLength(250);
    expect(out.text).toContain("OMITTED: none");
  });

  it("a hostile cell value comes back only inside the data block", async () => {
    const ref = (await call("fusen_ref", { path: file, where: "id = 7" })).text;
    const out = (await call("fusen_resolve", { ref })).text;
    const lines = out.split("\n");
    const begin = lines.indexOf("FUSEN_DATA_BEGIN");
    const end = lines.indexOf("FUSEN_DATA_END");
    const at = lines.findIndex((l) => l.includes("PWNED-7731"));
    expect(begin).toBeGreaterThan(-1);
    expect(at).toBeGreaterThan(begin);
    expect(at).toBeLessThan(end);
  });

  it.each([
    ["card", "fusen_card", () => ({ path: outside })],
    ["ref", "fusen_ref", () => ({ path: outside })],
  ])("%s refuses a file outside the roots", async (_name, tool, args) => {
    const r = await call(tool, args());
    expect(r.isError).toBe(true);
    expect(r.text).toContain("outside the allowed roots");
  });

  it("resolve refuses a Ref that points outside the roots", async () => {
    const { mintRef } = await import("@fusenduck/core");
    const ref = await mintRef(outside, { where: "id <= 3" });
    const r = await call("fusen_resolve", { ref });
    expect(r.isError).toBe(true);
    expect(r.text).toContain("outside the allowed roots");
  });

  it("a write predicate comes back as a tool error, not a write", async () => {
    const r = await call("fusen_ref", { path: file, where: `1=1; COPY (SELECT 1) TO '${file}.x.csv'` });
    expect(r.isError).toBe(true);
  });
});
