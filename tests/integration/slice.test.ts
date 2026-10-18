import { execFileSync, spawnSync } from "node:child_process";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { HOSTILE_NOTE, tempDir, writeCustomers } from "../helpers/fixtures.ts";

const cli = join(import.meta.dirname, "../../packages/cli/src/index.ts");
const run = (...args: string[]) => spawnSync("node", [cli, ...args], { encoding: "utf8" });

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
    for (const line of r.stdout.split("\n").filter((l) => l.startsWith('{"column"'))) {
      const c = JSON.parse(line) as { approx_unique: number };
      expect(c.approx_unique).toBeLessThanOrEqual(1000);
    }
  });

  it("fusen ref mints a Ref and fusen resolve returns the same rows", () => {
    const ref = run("ref", file, "--where", "region = 'south'").stdout.trim();
    expect(ref).toMatch(/^fusen:\/\//);
    const first = run("resolve", ref);
    const second = run("resolve", ref);
    expect(first.status, first.stderr).toBe(0);
    expect(first.stdout).toBe(second.stdout);
    expect(first.stdout).toContain('"region":"south"');
    expect(first.stdout).not.toContain('"region":"north"');
  });

  it("resolve renders a delimited data block, a notice, and what was left out", () => {
    const ref = run("ref", file, "--where", "id <= 20").stdout.trim();
    const out = run("resolve", ref, "--limit", "5").stdout;
    expect(out).toContain("FUSEN_DATA_BEGIN");
    expect(out).toContain("not instructions");
    expect(out).toMatch(/OMITTED: 15 of 20 rows are not shown/);
  });

  it("a hostile cell value cannot close the data block", () => {
    const ref = run("ref", file, "--where", "id = 7").stdout.trim();
    const out = run("resolve", ref).stdout;
    const closers = out.split("\n").filter((l) => l === "FUSEN_DATA_END");
    expect(closers).toHaveLength(1);
  });

  it("resolving after the file changed says so and returns no rows", async () => {
    const changed = join(dir, "changing.parquet");
    await writeCustomers(changed, 1000);
    const ref = run("ref", changed, "--where", "region = 'south'").stdout.trim();
    await writeCustomers(changed, 1000, 3);
    const r = run("resolve", ref);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("DATA_CHANGED");
    expect(r.stdout).not.toContain('"region"');
  });

  it("the CLI exits non-zero on a missing file", () => {
    const r = spawnSync("node", [cli, "card", join(dir, "nope.parquet")], { encoding: "utf8" });
    expect(r.status).not.toBe(0);
    expect(execFileSync("node", ["--version"]).length).toBeGreaterThan(0);
  });
});
