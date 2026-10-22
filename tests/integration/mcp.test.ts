import { existsSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { formatRef, mintRef } from "@fusenduck/core";
import { tempDir, writeCustomers } from "../helpers/fixtures.ts";

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

  it("lists the four tools", async () => {
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(["fusen_card", "fusen_peek", "fusen_ref", "fusen_resolve"]);
  });

  it("fusen_peek returns the card, a few rows and a Ref in one result", async () => {
    const out = await call("fusen_peek", { path: file, rows: 3 });
    expect(out.isError).toBe(false);
    expect(out.text).toContain("rows: 1000");
    expect(out.text.slice(out.text.indexOf('level="rows"')).split("\n").filter((l) => l.startsWith("{"))).toHaveLength(3);
    expect(out.text).toMatch(/fusen:\/\/file\//);
    expect(out.text).toContain("OMITTED:");
  });

  it("fusen_ref shows the agent its own misspelled column, but not an engine error from reading rows", async () => {
    const bad = await call("fusen_ref", { path: file, where: "regon = 'south'" });
    expect(bad.isError).toBe(true);
    expect(bad.text).toBe('fusen error: selection rejected: Binder Error: Referenced column "regon" not found in FROM clause! A text value goes in single quotes, as in region = \'south\'.');
    const ref = (await call("fusen_ref", { path: file, where: "CAST(note AS INTEGER) = 1" })).text;
    const cast = await call("fusen_resolve", { ref });
    expect(cast.isError).toBe(true);
    expect(cast.text).toContain("Details are withheld");
    expect(cast.text).not.toContain("note ");
  });

  it("fusen_peek refuses a path outside the roots, like the other tools", async () => {
    const out = await call("fusen_peek", { path: outside });
    expect(out.isError).toBe(true);
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

  it("fusen_ref takes a query over `data`, and resolve returns the aggregate", async () => {
    const query = "SELECT region, count(*) AS n FROM data GROUP BY region";
    const ref = (await call("fusen_ref", { path: file, query, where: "n > 0" })).text;
    expect(ref).toMatch(/^fusen:\/\//);
    const out = await call("fusen_resolve", { ref });
    const rows = out.text.split("\n").filter((l) => l.startsWith("{")).map((l) => JSON.parse(l) as { n: string });
    expect(rows).toHaveLength(4);
    expect(rows.every((r) => Number(r.n) === 250)).toBe(true);
    const bad = await call("fusen_ref", { path: file, query: "SELECT 1; DROP TABLE data" });
    expect(bad.isError).toBe(true);
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
    const ref = await mintRef(outside, { where: "id <= 3" });
    const r = await call("fusen_resolve", { ref });
    expect(r.isError).toBe(true);
    expect(r.text).toContain("outside the allowed roots");
  });

  describe("paths that try to get around the root", () => {
    const link = join(dir, "link.parquet");
    const sub = join(dir, "sub");
    const text = join(dir, "notes.txt");

    beforeAll(() => {
      symlinkSync(outside, link);
      mkdirSync(sub, { recursive: true });
      writeFileSync(text, "not a parquet file");
    });

    it.each([
      ["a .. path", () => join(dir, "..", "x", "..", outside.slice(outside.lastIndexOf("/fusenduck-")))],
      ["a symlink inside the root that points out", () => link],
      ["a file that does not exist, outside the root", () => join(outside, "..", "nope.parquet")],
      ["a file that does not exist, inside the root", () => join(dir, "nope.parquet")],
      ["a sibling directory whose name starts with the root's name", () => `${dir}-evil/x.parquet`],
    ])("fusen_card refuses %s with the same message as any other denial", async (_name, path) => {
      const r = await call("fusen_card", { path: path() });
      expect(r.isError).toBe(true);
      expect(r.text).toContain("not readable or is outside the allowed roots");
    });

    it("resolve refuses a Ref whose source is a symlink that points outside", async () => {
      const ref = formatRef({ source: link, fingerprint: "000000000000" });
      const r = await call("fusen_resolve", { ref });
      expect(r.isError).toBe(true);
      expect(r.text).toContain("not readable or is outside the allowed roots");
    });

    it.each([
      ["a directory", () => sub],
      ["a file that is not Parquet", () => text],
    ])("%s is a tool error that does not echo engine details", async (_name, path) => {
      const r = await call("fusen_card", { path: path() });
      expect(r.isError).toBe(true);
      expect(r.text).toContain("withheld");
      expect(r.text).not.toContain("magic bytes");
    });
  });

  describe("engine errors cannot carry source values to the agent", () => {
    it.each([
      ["error() on a cell", "id > 0 AND (CASE WHEN id = 7 THEN error(note) ELSE true END)"],
      ["a failing cast of a cell", "CAST(note AS INTEGER) = 1"],
    ])("%s", async (_name, where) => {
      const ref = (await call("fusen_ref", { path: file, where })).text;
      const r = ref.startsWith("fusen://") ? await call("fusen_resolve", { ref }) : { isError: true, text: ref };
      expect(r.isError).toBe(true);
      expect(r.text).not.toContain("PWNED-7731");
      expect(r.text).not.toMatch(/'note \d+'/);
      expect(r.text).toContain("withheld");
    });
  });

  it("a write predicate comes back as a tool error and writes nothing", async () => {
    const target = `${file}.x.csv`;
    const r = await call("fusen_ref", { path: file, where: `1=1; COPY (SELECT 1) TO '${target}'` });
    expect(r.isError).toBe(true);
    expect(r.text).toContain("predicate rejected");
    expect(existsSync(target)).toBe(false);
  });
});
