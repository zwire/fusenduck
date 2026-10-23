import { join } from "node:path";
import { DuckDBInstance } from "@duckdb/node-api";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mintRef } from "@fusenduck/core";
import { lit } from "../../packages/core/src/engine.ts";
import { startWebServer, type WebHandle } from "../../apps/web/src/server.ts";
import { tempDir, writeCustomers } from "../helpers/fixtures.ts";
import { buildSpa, call } from "../helpers/web.ts";

// The messages a caller sees for its own mistakes (harden #24: the first line of a parser, binder or
// catalog error) and everything the Web UI sends back, tried against input built to make them carry
// the file's values or a secret from the environment.

const CELL = "CANARY-CELL-91c2d7";
const SECRET = "CANARY-ENV-5e0a44-do-not-leak";

async function writeSecret(path: string): Promise<void> {
  const connection = await (await DuckDBInstance.create(":memory:")).connect();
  // The text column comes first, so its value sits near the start of the file's bytes.
  await connection.run(`COPY (SELECT '${CELL}' AS secret, 1 AS id) TO ${lit(path)} (FORMAT parquet)`);
}

describe("errors about the caller's own selection carry no value from the file", () => {
  const dir = tempDir();
  const file = join(dir, "secret.parquet");

  beforeAll(async () => {
    await writeSecret(file);
  });

  it.each([
    // read_csv takes the file's first bytes as the header, and the binder lists those names as candidates.
    ["candidate names from bytes read as CSV", `secret IN (SELECT nope FROM read_csv(${lit(file)}, header=true, sep='\x02', quote='', escape='', all_varchar=true, ignore_errors=true, null_padding=true, strict_mode=false))`],
    ["a near miss of a name read from the bytes", `secret IN (SELECT CANARY FROM read_csv(${lit(file)}, header=true, all_varchar=true, ignore_errors=true, null_padding=true, strict_mode=false))`],
    ["keys of a JSON read of the bytes", `secret IN (SELECT nope FROM read_json(${lit(file)}, format='newline_delimited', ignore_errors=true))`],
    ["a struct key that does not exist", `struct_extract({'a': secret}, 'nope') = 1`],
    ["a cast that fails on a row", `CAST(secret AS INTEGER) > 0`],
  ])("%s", async (_name, where) => {
    const message = await mintRef(file, { where, roots: [dir] }).then(
      () => "minted",
      (error: unknown) => (error as Error).message,
    );
    expect(message).not.toContain(CELL);
  });
});

describe("the Web UI's answers carry no secret from the environment and no value outside the rows", () => {
  const dir = tempDir();
  const file = join(dir, "secret.parquet");
  const other = join(dir, "other.parquet");
  const outside = join(tempDir(), "outside.parquet");
  let handle: WebHandle;
  let base: string;
  let token: string;
  const answers: string[] = [];
  const api = async (path: string, body: Record<string, unknown>) => {
    const res = await call(base, path, body, { token });
    answers.push(`${path} ${JSON.stringify(res.body)}`);
    return res;
  };

  beforeAll(async () => {
    buildSpa();
    process.env.FUSEN_CANARY_SECRET = SECRET;
    await writeSecret(file);
    await writeCustomers(other, 5);
    await writeCustomers(outside, 5);
    handle = await startWebServer({ roots: [dir] });
    base = new URL(handle.url).origin;
    token = String((await call(base, "/api/session", { code: new URL(handle.url).hash.replace("#c=", "") })).body.token);
  });

  afterAll(async () => {
    delete process.env.FUSEN_CANARY_SECRET;
    await handle.close();
  });

  it("across every call and its failures", async () => {
    await api("/api/files", {});
    const opened = (await api("/api/open", { path: file })).body as { source: string; fingerprint: string };
    const { source, fingerprint } = opened;
    const rows = (where: string) => api("/api/rows", { source, fingerprint, offset: 0, limit: 5, where });
    expect((await rows("id = 1")).status).toBe(200);
    await api("/api/ref", { source, fingerprint, ranges: [[0, 0]], where: "id = 1", columns: ["id"] });
    // Failures: outside the roots, another file through a subquery, the environment, a failing cast.
    expect((await api("/api/open", { path: outside })).status).toBe(400);
    const another = await rows(`id IN (SELECT id FROM ${lit(other)})`);
    expect(another.status).toBe(500);
    for (const where of ["getenv('FUSEN_CANARY_SECRET') IS NOT NULL", "current_setting('FUSEN_CANARY_SECRET') IS NOT NULL", "CAST(secret AS INTEGER) > 0"]) {
      expect((await rows(where)).status, where).not.toBe(200);
    }
    expect(answers.join("\n")).not.toContain(SECRET);
    // The answers that may carry the cell are the card (its min and max) and the page of rows.
    expect(answers.filter((a) => a.includes(CELL)).map((a) => a.split(" ")[0])).toEqual(["/api/open", "/api/rows"]);
  });
});
