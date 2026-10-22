import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { fingerprint, mintRef, mintRefWith, openSource, resolveRef, SourceChanged } from "@fusenduck/core";
import { tempDir, writeCustomers } from "../helpers/fixtures.ts";

const ids = (out: string) => out.split("\n").filter((l) => l.startsWith("{")).map((l) => Number((JSON.parse(l) as { id: string }).id));

// What a person saw must be what the Ref selects: minting takes the fingerprint the view was rendered
// from and refuses when the file has changed since (docs/adr/0002, 3).
describe("minting against the fingerprint that was seen", () => {
  const dir = tempDir();
  const file = join(dir, "customers.parquet");
  let seen: string;

  beforeAll(async () => {
    await writeCustomers(file, 100);
    const engine = await openSource(file);
    seen = await fingerprint(engine);
    engine.close();
  });

  it("mints when the file still has the expected fingerprint", async () => {
    const ref = await mintRef(file, { where: "file_row_number = 6", expect: seen });
    expect(ids(await resolveRef(ref, { roots: [dir] }))).toEqual([7]);
  });

  it("refuses to mint after the file changed, instead of selecting another row", async () => {
    // A file of the same shape with one more row stands for the same file rewritten.
    const changed = join(dir, "changed.parquet");
    await writeCustomers(changed, 101);
    await expect(mintRef(changed, { where: "file_row_number = 6", expect: seen })).rejects.toBeInstanceOf(SourceChanged);
  });

  it("mints on an open engine it does not close, and the engine can be closed after", async () => {
    const engine = await openSource(file, { roots: [dir] });
    const a = await mintRefWith(engine, { where: "file_row_number BETWEEN 1 AND 2", expect: seen });
    const b = await mintRefWith(engine, { where: "file_row_number = 9", expect: seen });
    expect(ids(await resolveRef(a, { roots: [dir] }))).toEqual([2, 3]);
    expect(ids(await resolveRef(b, { roots: [dir] }))).toEqual([10]);
    engine.close();
    await expect(engine.query("SELECT 1")).rejects.toThrow();
  });
});
