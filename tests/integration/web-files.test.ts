import { mkdirSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { listFiles, MAX_FILES } from "../../apps/web/src/files.ts";
import { startWebServer, type WebHandle } from "../../apps/web/src/server.ts";
import { tempDir, writeCustomers } from "../helpers/fixtures.ts";
import { buildSpa, call } from "../helpers/web.ts";

const names = (listed: Awaited<ReturnType<typeof listFiles>>, i = 0) => listed.roots[i]!.files.map((f) => f.name);

describe("Web UI: the list of files under the roots (docs/adr/0002)", () => {
  // Real paths, so the paths in the list can be compared (macOS puts temp files under a symlink).
  const dir = realpathSync(tempDir());
  const outside = realpathSync(tempDir());

  beforeAll(async () => {
    await writeCustomers(join(dir, "customers.parquet"), 10);
    mkdirSync(join(dir, "sales/2026"), { recursive: true });
    await writeCustomers(join(dir, "sales/2026/q1.PARQUET"), 10);
    await writeCustomers(join(dir, "sales/a.parquet"), 10);
    writeFileSync(join(dir, "notes.txt"), "a,b\n");
    mkdirSync(join(dir, ".cache"));
    writeFileSync(join(dir, ".cache/hidden.parquet"), "x");
    writeFileSync(join(dir, ".dot.parquet"), "x");
    await writeCustomers(join(outside, "secret.parquet"), 10);
    mkdirSync(join(outside, "deep"));
    writeFileSync(join(outside, "deep/also-secret.parquet"), "x");
    // Links that would lead out of the root, or back into it, are never followed.
    symlinkSync(join(outside, "secret.parquet"), join(dir, "link.parquet"));
    symlinkSync(outside, join(dir, "linked-dir"), "junction");
    symlinkSync(dir, join(dir, "sales/loop"), "junction");
  });

  it("lists the Parquet files under a root by their path from it, sorted, with size and time", async () => {
    const listed = await listFiles([dir]);
    expect(listed.truncated).toBe(false);
    expect(listed.roots[0]!.root).toBe(dir);
    expect(names(listed)).toEqual(["customers.parquet", "sales/2026/q1.PARQUET", "sales/a.parquet"]);
    const [first] = listed.roots[0]!.files;
    expect(first!.path).toBe(join(dir, "customers.parquet"));
    expect(first!.size).toBeGreaterThan(0);
    expect(first!.modified).toBeGreaterThan(0);
  });

  it("follows no symlink and skips hidden files and folders, so nothing outside the root is named", async () => {
    const listed = JSON.stringify(await listFiles([dir]));
    expect(listed).not.toContain("secret");
    expect(listed).not.toContain("hidden");
    expect(listed).not.toContain(".dot");
    expect(listed).not.toContain("loop");
  });

  it("lists each root on its own; a missing root is listed empty and a file is listed once", async () => {
    const listed = await listFiles([dir, join(dir, "sales"), join(dir, "missing")]);
    expect(listed.roots.map((r) => r.root)).toEqual([dir, join(dir, "sales"), join(dir, "missing")]);
    expect(names(listed, 1)).toEqual([]);
    expect(listed.roots[2]!.files).toEqual([]);
  });

  it(`stops at ${MAX_FILES} files under a root and says so; the next root keeps its own limit`, async () => {
    const many = tempDir();
    for (let i = 0; i <= MAX_FILES; i++) writeFileSync(join(many, `f${String(i).padStart(5, "0")}.parquet`), "");
    const listed = await listFiles([many, join(dir, "sales")]);
    expect(listed.truncated).toBe(true);
    expect(listed.roots[0]!.truncated).toBe(true);
    expect(listed.roots[0]!.files).toHaveLength(MAX_FILES);
    expect(listed.roots[1]!.truncated).toBe(false);
    expect(names(listed, 1)).toEqual(["2026/q1.PARQUET", "a.parquet"]);
  });

  describe("through the server", () => {
    let handle: WebHandle;
    let base: string;
    let token: string;

    beforeAll(async () => {
      buildSpa();
      handle = await startWebServer({ roots: [dir] });
      base = new URL(handle.url).origin;
      token = String((await call(base, "/api/session", { code: new URL(handle.url).hash.replace("#c=", "") })).body.token);
    });

    afterAll(async () => {
      await handle.close();
    });

    it("POST /api/files needs the token and returns the list; each listed path opens", async () => {
      expect((await call(base, "/api/files", {})).status).toBe(401);
      const listed = await call(base, "/api/files", {}, { token });
      expect(listed.status).toBe(200);
      const { roots } = listed.body as { roots: { files: { path: string; name: string }[] }[] };
      expect(roots[0]!.files.map((f) => f.name)).toEqual(["customers.parquet", "sales/2026/q1.PARQUET", "sales/a.parquet"]);
      for (const f of roots[0]!.files) expect((await call(base, "/api/open", { path: f.path }, { token })).status).toBe(200);
    });
  });
});
