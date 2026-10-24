import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { openSource, resolveRef } from "@fusenduck/core";
import { tempDir } from "../helpers/fixtures.ts";

// The same locks as the Parquet engine (readonly.test.ts), run against each text kind.
describe.each([
  { name: "people.csv", text: "id,name\n1,a\n2,b\n", read: (f: string) => `read_csv('${f}')` },
  { name: "people.ndjson", text: '{"id":1}\n{"id":2}\n', read: (f: string) => `read_json('${f}', format='newline_delimited')` },
])("the engine over $name", ({ name, text, read }) => {
  const dir = tempDir();
  const file = join(dir, name);
  const sibling = join(dir, "sibling.csv");

  beforeAll(() => {
    writeFileSync(file, text);
    writeFileSync(sibling, "x\n1\n");
  });

  it.each([
    ["reading another file", (f: string) => `SELECT * FROM read_csv('${f.replace(name, "sibling.csv")}')`],
    ["reading a system file", () => `SELECT * FROM read_csv('/etc/hostname')`],
    ["COPY TO a new file", (f: string) => `COPY (SELECT 1) TO '${f}.out.csv'`],
    ["overwriting the opened file", (f: string) => `COPY (SELECT 1 x) TO '${f}' (FORMAT csv)`],
    ["ATTACH a database file", (f: string) => `ATTACH '${f}.db'`],
    ["unlocking the configuration", () => `SET enable_external_access=true`],
    ["widening the allow-list", (f: string) => `SET allowed_paths=['${f}','/etc/hostname']`],
  ])("rejects %s", async (_what, sql) => {
    const engine = await openSource(file);
    try {
      await expect(engine.query(sql(file))).rejects.toThrow();
      const rows = await engine.query(`SELECT count(*) AS n FROM ${read(file)}`);
      expect(rows[0]?.n).toBe("2");
    } finally {
      engine.close();
    }
  });

  it("refuses a Ref whose path is outside the allowed roots", async () => {
    const engine = await openSource(file);
    engine.close();
    const outside = tempDir();
    await expect(
      resolveRef(`fusen://file/${encodeURIComponent(file)}?v=000000000000&src=${name.endsWith("csv") ? "csv" : "ndjson"}`, { roots: [outside] }),
    ).rejects.toThrow(/outside the allowed roots/);
  });
});

describe("settings that arrive in a Ref are data, not SQL", () => {
  const dir = tempDir();
  const file = join(dir, "t.csv");

  beforeAll(() => {
    writeFileSync(file, "a,b\n1,2\n");
  });

  it("quotes hostile column names and types instead of running them", async () => {
    const columns = JSON.stringify([["a", "BIGINT"], ["b", "BIGINT'}); COPY (SELECT 1) TO '/tmp/pwned.csv'; --"]]);
    const ref =
      `fusen://file/${encodeURIComponent(file)}?v=000000000000&src=csv&opt.delim=%2C&opt.quote=%22&opt.escape=%22&opt.header=true&opt.columns=${encodeURIComponent(columns)}`;
    await expect(resolveRef(ref, { roots: [dir] })).rejects.toThrow();
  });

  it("rejects a delimiter that is a line break", async () => {
    const ref = `fusen://file/${encodeURIComponent(file)}?v=000000000000&src=csv&opt.delim=%0A&opt.quote=%22&opt.escape=%22&opt.header=true&opt.columns=${encodeURIComponent('[["a","BIGINT"]]')}`;
    await expect(resolveRef(ref, { roots: [dir] })).rejects.toThrow(/delim/);
  });
});
