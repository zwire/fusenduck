import { execFileSync, spawnSync } from "node:child_process";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { statSync } from "node:fs";
import { DuckDBInstance } from "@duckdb/node-api";
import { HOSTILE_NOTE, tempDir, writeCustomers } from "../helpers/fixtures.ts";

const cli = join(import.meta.dirname, "../../packages/cli/src/index.ts");
const run = (...args: string[]) => spawnSync("node", [cli, ...args], { encoding: "utf8" });
// Refs resolve only under the roots given; the fixtures live in a temp directory.
const resolve = (dir: string, ref: string, ...more: string[]) => run("resolve", ref, "--root", dir, ...more);
const dataLines = (out: string) => out.split("\n").filter((l) => l.startsWith("{"));

describe("first slice: card, ref, resolve through the CLI", () => {
  const dir = tempDir();
  const file = join(dir, "customers.parquet");

  beforeAll(async () => {
    await writeCustomers(file, 1000);
  });

  it("fusen card prints schema, row count and null rate, labels approximate fields, and truncates text min/max", () => {
    const r = run("card", file);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain("rows: 1000");
    expect(r.stdout).toMatch(/"column":"status".*"null_percentage":"9\.0/);
    expect(r.stdout).toContain("approximate: approx_unique, avg");
    expect(r.stdout).not.toContain(HOSTILE_NOTE);
    const note = r.stdout.split("\n").find((l) => l.startsWith('{"column":"note"')) ?? "";
    const { min } = JSON.parse(note) as { min: string };
    expect(min).toBe(`${HOSTILE_NOTE.slice(0, 40)}…`);
    for (const line of r.stdout.split("\n").filter((l) => l.startsWith('{"column"'))) {
      const c = JSON.parse(line) as { approx_unique: number };
      expect(c.approx_unique).toBeLessThanOrEqual(1000);
    }
  });

  it("fusen ref mints a Ref and fusen resolve returns the same rows", () => {
    const ref = run("ref", file, "--where", "region = 'south'").stdout.trim();
    expect(ref).toMatch(/^fusen:\/\//);
    const first = resolve(dir, ref, "--limit", "1000");
    const second = resolve(dir, ref, "--limit", "1000");
    expect(first.status, first.stderr).toBe(0);
    expect(first.stdout).toBe(second.stdout);
    // region = (i % 4 == 1) -> 250 of the 1000 ids, and nothing else.
    const rows = dataLines(first.stdout).map((l) => JSON.parse(l) as { id: string; region: string });
    expect(rows).toHaveLength(250);
    expect(rows.every((r) => r.region === "south" && Number(r.id) % 4 === 1)).toBe(true);
  });

  it("resolve renders a delimited data block, a notice, and what was left out", () => {
    const ref = run("ref", file, "--where", "id <= 20").stdout.trim();
    const out = resolve(dir, ref, "--limit", "5").stdout;
    expect(out).toContain("FUSEN_DATA_BEGIN");
    expect(out).toContain("not instructions");
    expect(out).toMatch(/OMITTED: 15 of 20 rows are not shown/);
  });

  it("a hostile cell value cannot close the data block", () => {
    const ref = run("ref", file, "--where", "id = 7").stdout.trim();
    const out = resolve(dir, ref).stdout;
    expect(out.split("\n").filter((l) => l === "FUSEN_DATA_END")).toHaveLength(1);
    // the hostile text is there, but only as the value inside one JSON data line
    const line = dataLines(out).find((l) => l.includes("FUSEN_DATA_END")) ?? "";
    expect((JSON.parse(line) as { note: string }).note).toBe(HOSTILE_NOTE);
  });

  it("resolving after the file changed says so and returns no rows", async () => {
    const changed = join(dir, "changing.parquet");
    await writeCustomers(changed, 1000);
    const ref = run("ref", changed, "--where", "region = 'south'").stdout.trim();
    await writeCustomers(changed, 1000, 3);
    const r = resolve(dir, ref);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("DATA_CHANGED");
    expect(r.stdout).not.toContain('"region"');
  });

  it("a rewrite that keeps the row count and the file size, but changes values, is detected", async () => {
    const changed = join(dir, "same-shape.parquet");
    const connection = await (await DuckDBInstance.create(":memory:")).connect();
    const write = (offset: number) =>
      connection.run(`COPY (SELECT ${offset} + i AS v FROM range(1, 1001) t(i)) TO '${changed}' (FORMAT parquet)`);
    await write(1000);
    const size = statSync(changed).size;
    const ref = run("ref", changed, "--where", "v > 0").stdout.trim();
    await write(1001);
    expect(statSync(changed).size).toBe(size); // the cheap fingerprint cannot tell these apart
    const r = resolve(dir, ref);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("DATA_CHANGED");
  });

  it("fusen peek prints the card, the first rows and a Ref, with hostile values inside the data block", () => {
    const r = run("peek", file, "--rows", "10");
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain("rows: 1000");
    const rowsBlock = r.stdout.slice(r.stdout.indexOf('level="rows"'));
    expect(dataLines(rowsBlock)).toHaveLength(10);
    expect(r.stdout.split("\n").filter((l) => l === "FUSEN_DATA_END")).toHaveLength(2); // one block per part
    const ref = /ref="([^"]+)"/.exec(r.stdout)?.[1];
    expect(ref).toMatch(/^fusen:\/\//);
  });

  it("fusen peek defaults to a handful of rows and rejects a bad --rows", () => {
    const out = run("peek", file).stdout;
    expect(dataLines(out.slice(out.indexOf('level="rows"'))).length).toBe(5);
    expect(run("peek", file, "--rows", "-1").status).toBe(1);
    expect(run("peek", file, "--rows", "1000").status).toBe(1);
    for (const bad of ["", " 3", "1e1", "1.5", "abc"]) expect(run("peek", file, "--rows", bad).status, bad).toBe(1);
  });

  it("a Ref outside --root is refused", () => {
    const ref = run("ref", file, "--where", "id <= 5").stdout.trim();
    const r = run("resolve", ref, "--root", tempDir());
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("outside the allowed roots");
  });

  it.each([
    ["--where with no value", ["ref", "FILE", "--where"]],
    ["an empty --where", ["ref", "FILE", "--where", " "]],
    ["an empty --columns", ["ref", "FILE", "--columns", ""]],
    ["an unknown flag", ["ref", "FILE", "--wher", "id<3"]],
    ["a flag that belongs to another command", ["card", "FILE", "--limit", "3"]],
    ["a non-numeric --limit", ["resolve", "fusen://file/x?v=1", "--limit", "abc"]],
    ["a negative --limit", ["resolve", "fusen://file/x?v=1", "--limit", "-3"]],
  ])("rejects %s with exit 1 and no Ref", (_name, args) => {
    const r = run(...args.map((a) => (a === "FILE" ? file : a)));
    expect(r.status).toBe(1);
    expect(r.stdout).toBe("");
  });

  it("the CLI exits non-zero on a missing file", () => {
    const r = spawnSync("node", [cli, "card", join(dir, "nope.parquet")], { encoding: "utf8" });
    expect(r.status).not.toBe(0);
    expect(execFileSync("node", ["--version"]).length).toBeGreaterThan(0);
  });
});
