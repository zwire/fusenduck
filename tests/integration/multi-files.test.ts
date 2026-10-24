import { realpathSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { beforeAll, describe, expect, it } from "vitest";
import { mintRef, parseRef, resolveRef } from "@fusenduck/core";
import { tempDir, writeCustomers } from "../helpers/fixtures.ts";

const cli = join(import.meta.dirname, "../../packages/cli/src/index.ts");
const run = (...args: string[]) => spawnSync("node", [cli, ...args], { encoding: "utf8" });
const refOf = (out: string) => out.trim().split("\n").pop()!;

describe("a pattern that names several files", () => {
  const dir = tempDir();

  beforeAll(async () => {
    await writeCustomers(join(dir, "p1.parquet"), 5);
    await writeCustomers(join(dir, "p2.parquet"), 7);
    for (const [name, rows] of [["a", 40_000], ["b", 40_000], ["c", 3]] as const) {
      writeFileSync(join(dir, `part-${name}.csv`), `id,v\n${Array.from({ length: rows }, (_, i) => `${i},${name}${i}`).join("\n")}\n`);
      writeFileSync(join(dir, `part-${name}.ndjson`), `${Array.from({ length: rows }, (_, i) => `{"id":${i},"v":"${name}${i}"}`).join("\n")}\n`);
    }
  });

  it.each(["p*.parquet", "part-*.csv", "part-*.ndjson"])("reads %s as one table with a filename column", (pattern) => {
    const out = run("card", join(dir, pattern));
    expect(out.status).toBe(0);
    expect(out.stdout).toContain('"column":"filename"');
  });

  it("counts every file's rows", () => {
    const ref = refOf(run("ref", join(dir, "p*.parquet")).stdout);
    expect(run("resolve", ref, "--root", dir, "--limit", "50").stdout).toContain("All 12 matching rows");
  });

  it.each(["part-*.csv", "part-*.ndjson"])("selects a row by file and position in %s, also deep in a large file", (pattern) => {
    for (const [file, position, id] of [["part-a", 0, 0], ["part-a", 39_999, 39_999], ["part-b", 25_000, 25_000], ["part-c", 2, 2]] as const) {
      const ext = pattern.endsWith("csv") ? "csv" : "ndjson";
      const where = `filename LIKE '%${file}.${ext}' AND file_row_number = ${position}`;
      const ref = refOf(run("ref", join(dir, pattern), "--where", where).stdout);
      const out = run("resolve", ref, "--root", dir).stdout;
      expect(out).toContain(`"id":"${id}"`);
      expect(out).toContain(`"v":"${file.slice(-1)}${id}"`);
      expect(out).toContain("All 1 matching rows");
    }
  });

  it("says the data changed when a file is added, and again when one is removed", () => {
    const ref = refOf(run("ref", join(dir, "part-*.csv"), "--where", "id = 1").stdout);
    const extra = join(dir, "part-d.csv");
    writeFileSync(extra, "id,v\n1,d1\n");
    expect(run("resolve", ref, "--root", dir).stdout).toContain("DATA_CHANGED");
    unlinkSync(extra);
    expect(run("resolve", ref, "--root", dir).stdout).not.toContain("DATA_CHANGED");
  });

  it("keeps the pattern in the Ref and a plain path unchanged", () => {
    // The Ref holds the real path of the directory (on macOS /var is /private/var).
    const real = realpathSync(dir);
    expect(parseRef(refOf(run("ref", join(dir, "part-*.csv")).stdout)).source).toBe(join(real, "part-*.csv"));
    const single = parseRef(refOf(run("ref", join(dir, "p1.parquet")).stdout));
    expect(single.source).toBe(join(real, "p1.parquet"));
  });

  it("refuses a pattern with no match, and a wildcard in a directory", () => {
    expect(run("card", join(dir, "nothing-*.csv")).status).not.toBe(0);
    expect(run("card", join(dir, "*", "part-a.csv")).status).not.toBe(0);
  });

  // Creating a symbolic link needs a privilege on Windows.
  it.skipIf(process.platform === "win32")("leaves out a link that points outside the roots, and does not read dot files", async () => {
    const outside = tempDir();
    writeFileSync(join(outside, "secret.csv"), "id,v\n1,SECRET\n");
    const inner = tempDir();
    writeFileSync(join(inner, "ok.csv"), "id,v\n1,fine\n");
    writeFileSync(join(inner, ".hidden.csv"), "id,v\n1,HIDDEN\n");
    symlinkSync(join(outside, "secret.csv"), join(inner, "link.csv"));
    const ref = await mintRef(join(inner, "*.csv"), { roots: [inner] });
    const out = await resolveRef(ref, { roots: [inner] });
    expect(out).toContain("fine");
    expect(out).not.toContain("HIDDEN");
    expect(out).not.toContain("SECRET");
    // With no roots the link is followed, which is another list of files and so another fingerprint.
    expect(await mintRef(join(inner, "*.csv"))).not.toBe(ref);
  });
});
