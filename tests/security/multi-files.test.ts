import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { openSource, resolveRef } from "@fusenduck/core";
import { tempDir } from "../helpers/fixtures.ts";

// The locks over a pattern: the same refusals as for one file, and nothing beyond the files it named.
describe("the engine over a pattern", () => {
  const dir = tempDir();
  const pattern = join(dir, "part-*.csv");

  beforeAll(() => {
    writeFileSync(join(dir, "part-1.csv"), "id,v\n1,a\n");
    writeFileSync(join(dir, "part-2.csv"), "id,v\n2,b\n");
    writeFileSync(join(dir, "other.csv"), "id,v\n3,c\n");
  });

  it.each([
    ["a file the pattern did not match", () => `SELECT * FROM read_csv('${join(dir, "other.csv")}')`],
    ["a system file", () => `SELECT * FROM read_csv('/etc/hostname')`],
    ["COPY TO a new file", () => `COPY (SELECT 1) TO '${join(dir, "out.csv")}'`],
    ["overwriting a matched file", () => `COPY (SELECT 1 x) TO '${join(dir, "part-1.csv")}' (FORMAT csv)`],
    ["ATTACH a database file", () => `ATTACH '${join(dir, "x.db")}'`],
    ["unlocking the configuration", () => `SET enable_external_access=true`],
    ["widening the allow-list", () => `SET allowed_paths=['/etc/hostname']`],
  ])("rejects %s", async (_what, sql) => {
    const engine = await openSource(pattern);
    try {
      expect(engine.files).toHaveLength(2);
      await expect(engine.query(sql())).rejects.toThrow();
      expect((await engine.query("SELECT count(*) AS n FROM data"))[0]?.n).toBe("2");
    } finally {
      engine.close();
    }
  });

  it("refuses a Ref whose pattern is outside the allowed roots", async () => {
    const other = tempDir();
    await expect(resolveRef(`fusen://file/${encodeURIComponent(pattern)}?v=000000000000&src=csv`, { roots: [other] })).rejects.toThrow(
      /no file matches|outside the allowed roots/,
    );
  });

  it("refuses a pattern that names too many files", async () => {
    const many = tempDir();
    for (let i = 0; i < 257; i++) writeFileSync(join(many, `f${i}.csv`), "id\n1\n");
    await expect(openSource(join(many, "f*.csv"))).rejects.toThrow(/more than 256 files/);
  });
});
