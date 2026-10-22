import { spawn } from "node:child_process";
import { request } from "node:http";
import { copyFileSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { resolveRef } from "@fusenduck/core";
import { CODE_TTL_MS, CSP, MAX_BODY_BYTES, startWebServer, type WebHandle } from "../../apps/web/src/server.ts";
import { MAX_RANGES } from "../../apps/web/src/view.ts";
import { tempDir, writeCustomers } from "../helpers/fixtures.ts";
import { buildSpa, call, writeOwnPositionColumn } from "../helpers/web.ts";

const entry = join(import.meta.dirname, "../../apps/web/src/index.ts");
const ids = (out: string) => out.split("\n").filter((l) => l.startsWith("{")).map((l) => Number((JSON.parse(l) as { id: string }).id));

/** A raw request, so Host and other headers fetch would fix up can be set by hand. */
function raw(url: string, headers: Record<string, string>, body = "{}", method = "POST"): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = request(url, { method, headers }, (res) => {
      res.resume();
      resolve(res.statusCode ?? 0);
    });
    req.on("error", reject);
    req.end(method === "GET" ? undefined : body);
  });
}

const codeOf = (url: string) => new URL(url).hash.replace("#c=", "");

describe("Web UI server: the API's guards (docs/adr/0002, acceptance 3 and 5)", () => {
  const dir = tempDir();
  const file = join(dir, "customers.parquet");
  let handle: WebHandle;
  let base: string;
  let token: string;

  beforeAll(async () => {
    buildSpa();
    await writeCustomers(file, 1000);
    handle = await startWebServer({ roots: [dir] });
    base = new URL(handle.url).origin;
    const traded = await call(base, "/api/session", { code: codeOf(handle.url) });
    expect(traded.status).toBe(200);
    token = String(traded.body.token);
  });

  afterAll(async () => {
    await handle.close();
  });

  it("the URL carries a code in its fragment, not the token, and the code works once only", async () => {
    expect(handle.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/#c=[\w-]{43}$/);
    expect(handle.url).not.toContain(token);
    const again = await call(base, "/api/session", { code: codeOf(handle.url) });
    expect(again.status).toBe(401);
    expect(again.body.token).toBeUndefined();
  });

  it("the code expires after 60 seconds", async () => {
    let now = 0;
    const late = await startWebServer({ roots: [dir], now: () => now });
    try {
      const lateBase = new URL(late.url).origin;
      now = CODE_TTL_MS + 1;
      expect((await call(lateBase, "/api/session", { code: codeOf(late.url) })).status).toBe(401);
      now = 0;
      // A wrong code is refused too, and does not use up the right one.
      expect((await call(lateBase, "/api/session", { code: "x".repeat(43) })).status).toBe(401);
      expect((await call(lateBase, "/api/session", { code: codeOf(late.url) })).status).toBe(200);
    } finally {
      await late.close();
    }
  });

  it("refuses an API call without the token or with a wrong one (401)", async () => {
    expect((await call(base, "/api/open", { path: file })).status).toBe(401);
    expect((await call(base, "/api/open", { path: file }, { token: `${token}x` })).status).toBe(401);
    expect((await call(base, "/api/open", { path: file }, { headers: { authorization: token } })).status).toBe(401);
  });

  it("refuses another Origin (403) and another Host (403), even with the token", async () => {
    const auth = { authorization: `Bearer ${token}`, "content-type": "application/json" };
    expect(await raw(`${base}/api/open`, { ...auth, origin: "http://evil.example" }, JSON.stringify({ path: file }))).toBe(403);
    expect(await raw(`${base}/api/open`, { ...auth, origin: "null" }, JSON.stringify({ path: file }))).toBe(403);
    expect(await raw(`${base}/api/open`, { ...auth, host: "evil.example" }, JSON.stringify({ path: file }))).toBe(403);
    expect(await raw(`${base}/`, { host: "evil.example" }, "", "GET")).toBe(403);
    // The server's own names are accepted.
    const port = new URL(base).port;
    expect(await raw(`${base}/api/open`, { ...auth, host: `localhost:${port}`, origin: `http://localhost:${port}` }, JSON.stringify({ path: file }))).toBe(200);
  });

  it("refuses a body that is not JSON (415), so a page elsewhere cannot send a simple request", async () => {
    for (const type of ["text/plain", "application/x-www-form-urlencoded", "multipart/form-data; boundary=x"]) {
      const res = await call(base, "/api/open", undefined, { token, headers: { "content-type": type }, raw: JSON.stringify({ path: file }) });
      expect(res.status, type).toBe(415);
    }
    expect((await call(base, "/api/open", undefined, { token, raw: "{not json" })).status).toBe(400);
    expect((await call(base, "/api/open", undefined, { token, raw: JSON.stringify({ pad: "x".repeat(MAX_BODY_BYTES) }) })).status).toBe(413);
  });

  it("refuses a path outside the roots with a fixed message", async () => {
    for (const path of ["/etc/passwd", "../../../../etc/passwd", join(tempDir(), "missing.parquet")]) {
      const res = await call(base, "/api/open", { path }, { token });
      expect(res.status).toBe(400);
      expect(res.body.error).toBe(`the source is not readable or is outside the allowed roots: ${resolve(dir, path)}`);
    }
  });

  it("refuses to bind an address that is not loopback", async () => {
    await expect(startWebServer({ roots: [dir], host: "0.0.0.0" })).rejects.toThrow(/loopback/);
  });

  it("every response carries the CSP and the other headers; static files need no token", async () => {
    for (const path of ["/", "/app.js", "/api.js", "/style.css"]) {
      const res = await fetch(`${base}${path}`);
      expect(res.status, path).toBe(200);
      expect(res.headers.get("content-security-policy")).toBe(
        "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; " +
          "frame-ancestors 'none'; base-uri 'none'; form-action 'none'; require-trusted-types-for 'script'",
      );
      expect(res.headers.get("x-content-type-options")).toBe("nosniff");
      expect(res.headers.get("referrer-policy")).toBe("no-referrer");
      expect(res.headers.get("cache-control")).toBe("no-store");
      expect(res.headers.get("access-control-allow-origin")).toBeNull();
    }
    const denied = await call(base, "/api/open", { path: file });
    expect(denied.headers.get("content-security-policy")).toBe(CSP);
    expect((await fetch(`${base}/../packages/core/src/index.ts`)).status).toBe(404);
    expect((await fetch(`${base}/index.ts`)).status).toBe(404);
  });

  it("the entry point refuses a host that is not loopback, with a message", async () => {
    const child = spawn("node", [entry, "--host", "0.0.0.0", "--root", dir], { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
    expect(await new Promise((resolve) => child.on("exit", resolve))).toBe(1);
    expect(stderr).toMatch(/^fusen-web: --host must be a loopback address/);
  });
});

describe("Web UI server: open, rows and ref", () => {
  // The server names files by their real path (macOS puts temp files under a symlink).
  const dir = realpathSync(tempDir());
  const file = join(dir, "customers.parquet");
  const own = join(dir, "own.parquet");
  let handle: WebHandle;
  let base: string;
  let token: string;
  const api = (path: string, body: unknown) => call(base, path, body, { token });

  beforeAll(async () => {
    buildSpa();
    await writeCustomers(file, 1000);
    await writeOwnPositionColumn(own);
    handle = await startWebServer({ roots: [dir] });
    base = new URL(handle.url).origin;
    token = String((await call(base, "/api/session", { code: codeOf(handle.url) })).body.token);
  });

  afterAll(async () => {
    await handle.close();
  });

  it("opens a file (relative to the first root), pages its rows by position, and mints a Ref for a selection", async () => {
    const opened = (await api("/api/open", { path: "customers.parquet" })).body as {
      source: string;
      fingerprint: string;
      ref: string;
      selectable: boolean;
      card: { rows: number };
    };
    expect(opened.source).toBe(realpathSync(file));
    expect(opened.card.rows).toBe(1000);
    expect(opened.selectable).toBe(true);
    expect(ids(await resolveRef(opened.ref, { roots: [dir], limit: 1000 }))).toHaveLength(1000);

    const page = (await api("/api/rows", { source: file, fingerprint: opened.fingerprint, offset: 100, limit: 100 })).body as {
      rows: { pos: number; cells: string[] }[];
      next: number;
    };
    expect(page.rows.map((r) => r.pos)).toEqual(Array.from({ length: 100 }, (_, i) => 100 + i));
    expect(page.rows[0]!.cells[0]).toBe("101");
    expect(page.next).toBe(200);

    const minted = await api("/api/ref", { source: file, fingerprint: opened.fingerprint, ranges: [[150, 150], [10, 14], [12, 20], [21, 22], [40, 40]] });
    expect(minted.status).toBe(200);
    expect(String(minted.body.ref)).toContain(encodeURIComponent("file_row_number BETWEEN 10 AND 22 OR file_row_number = 40 OR file_row_number = 150"));
    expect(ids(await resolveRef(String(minted.body.ref), { roots: [dir] }))).toEqual([...Array.from({ length: 13 }, (_, i) => 11 + i), 41, 151]);
  });

  it("refuses ranges that are malformed, out of the file, or too many", async () => {
    // Room for more separate ranges than a selection may hold.
    const wide = join(dir, "wide.parquet");
    await writeCustomers(wide, 2 * MAX_RANGES + 2);
    const { fingerprint } = (await api("/api/open", { path: wide })).body as { fingerprint: string };
    const bad = async (ranges: unknown) => (await api("/api/ref", { source: wide, fingerprint, ranges })).status;
    expect(await bad([])).toBe(400);
    expect(await bad([[1]])).toBe(400);
    expect(await bad([["1; DROP", 2]])).toBe(400);
    expect(await bad([[5, 4]])).toBe(400);
    expect(await bad([[0, 2 * MAX_RANGES + 2]])).toBe(400);
    expect(await bad([[-1, 0]])).toBe(400);
    expect(await bad([[0.5, 1]])).toBe(400);
    expect(await bad(Array.from({ length: MAX_RANGES + 1 }, (_, i) => [i * 2, i * 2]))).toBe(400);
    expect(await bad(Array.from({ length: MAX_RANGES }, (_, i) => [i * 2, i * 2]))).toBe(200);
    expect((await api("/api/rows", { source: wide, fingerprint, offset: 0, limit: 501 })).status).toBe(400);
  });

  it("refuses rows and a Ref after the file changed (409), instead of selecting other rows", async () => {
    const path = join(dir, "changing.parquet");
    copyFileSync(file, path);
    const { fingerprint } = (await api("/api/open", { path })).body as { fingerprint: string };
    await writeCustomers(path, 1001);
    const ref = await api("/api/ref", { source: path, fingerprint, ranges: [[7, 7]] });
    expect(ref.status).toBe(409);
    expect(ref.body).toEqual({ error: "the file changed since it was opened. Open it again.", changed: true });
    expect((await api("/api/rows", { source: path, fingerprint, offset: 0 })).status).toBe(409);
  });

  it("pages through the rows that pass a filter, by position, and counts them", async () => {
    const { fingerprint } = (await api("/api/open", { path: file })).body as { fingerprint: string };
    const where = "region = 'south' AND id <= 40";
    const pages: { pos: number[]; next: number | null; matched: number }[] = [];
    let offset: number | null = 0;
    while (offset !== null) {
      const res = await api("/api/rows", { source: file, fingerprint, offset, limit: 4, where });
      expect(res.status).toBe(200);
      const body = res.body as { rows: { pos: number; cells: string[] }[]; next: number | null; matched: number };
      pages.push({ pos: body.rows.map((r) => r.pos), next: body.next, matched: body.matched });
      offset = body.next;
    }
    expect(pages).toEqual([
      { pos: [0, 4, 8, 12], next: 16, matched: 10 },
      { pos: [16, 20, 24, 28], next: 32, matched: 10 },
      { pos: [32, 36], next: null, matched: 10 },
    ]);
    // No filter (or a blank one) is every row.
    const all = (await api("/api/rows", { source: file, fingerprint, offset: 0, limit: 1, where: "  " })).body;
    expect(all.matched).toBe(1000);
    const none = (await api("/api/rows", { source: file, fingerprint, offset: 0, limit: 5, where: "id < 0" })).body;
    expect(none).toEqual({ rows: [], next: null, cut: false, matched: 0 });
  });

  it("mints a Ref for the rows that pass a filter, or for selected rows, keeping only the chosen columns", async () => {
    const { fingerprint } = (await api("/api/open", { path: file })).body as { fingerprint: string };
    const where = "region = 'south' AND id <= 40";
    const filtered = String((await api("/api/ref", { source: file, fingerprint, ranges: [], where, columns: ["note", "id"] })).body.ref);
    // Columns keep the file's order, whatever order the page sent them in.
    expect(filtered).toContain("&cols=id,note&");
    expect(decodeURIComponent(filtered)).toContain(`where=${where}`);
    const out = await resolveRef(filtered, { roots: [dir] });
    expect(ids(out)).toEqual(Array.from({ length: 10 }, (_, i) => 1 + 4 * i));
    expect(out).not.toContain('"region"');

    // Selected rows are named by position; the filter they were picked under is not added.
    const picked = String((await api("/api/ref", { source: file, fingerprint, ranges: [[8, 8]], where, columns: ["id"] })).body.ref);
    expect(decodeURIComponent(picked)).toContain("cols=id&where=file_row_number = 8");
    expect(decodeURIComponent(picked)).not.toContain("region");
    expect(ids(await resolveRef(picked, { roots: [dir] }))).toEqual([9]);

    // Columns alone, and every column (which leaves cols= out).
    const cols = String((await api("/api/ref", { source: file, fingerprint, ranges: [], columns: ["amount"] })).body.ref);
    expect(cols).toContain("cols=amount");
    expect(cols).not.toContain("where=");
    const every = String(
      (await api("/api/ref", { source: file, fingerprint, ranges: [[0, 0]], columns: ["id", "region", "amount", "status", "note"] })).body.ref,
    );
    expect(every).not.toContain("cols=");
  });

  it("refuses a bad filter with the reason, and bad columns", async () => {
    const { fingerprint } = (await api("/api/open", { path: file })).body as { fingerprint: string };
    const rows = (where: unknown) => api("/api/rows", { source: file, fingerprint, offset: 0, limit: 5, where });
    const ref = (where: unknown, columns?: unknown) => api("/api/ref", { source: file, fingerprint, ranges: [], where, columns });

    // A misspelled column: the binder's message names it, so the person can fix the filter.
    const typo = await rows("amont > 1");
    expect(typo.status).toBe(400);
    expect(String(typo.body.error)).toMatch(/^filter rejected: .*amont/);
    expect((await ref("amont > 1")).status).toBe(400);
    for (const bad of ["id > 1; DROP TABLE t", "id > 1) UNION SELECT * FROM t WHERE (1=1", "id > 1 LIMIT 1", "count(*) > 1", 7, "x".repeat(5000)]) {
      expect((await rows(bad)).status, String(bad)).toBe(400);
      expect((await ref(bad)).status, String(bad)).toBe(400);
    }
    // A filter that fails only while it reads rows would quote a cell in the engine's message: withheld.
    const cast = await rows("CAST(note AS INTEGER) > 0");
    expect(cast.status).toBe(500);
    expect(String(cast.body.error)).not.toContain("note 1");
    expect(String(cast.body.error)).toMatch(/withheld/);

    expect((await ref(undefined, ["nope"])).body.error).toBe('this file has no column named "nope"');
    expect((await ref(undefined, [])).status).toBe(400);
    expect((await ref(undefined, "id")).status).toBe(400);
    expect((await ref(undefined, [1])).status).toBe(400);
  });

  it("a file with its own file_row_number column opens, but its rows cannot be selected", async () => {
    const opened = (await api("/api/open", { path: own })).body as { fingerprint: string; selectable: boolean };
    expect(opened.selectable).toBe(false);
    const page = (await api("/api/rows", { source: own, fingerprint: opened.fingerprint, offset: 0, limit: 5 })).body as {
      rows: { pos: number | null; cells: string[] }[];
    };
    expect(page.rows.map((r) => r.pos)).toEqual([null, null, null, null, null]);
    expect(page.rows.map((r) => r.cells[1])).toEqual(["0", "10", "20", "30", "40"]);
    const ref = await api("/api/ref", { source: own, fingerprint: opened.fingerprint, ranges: [[1, 1]] });
    expect(ref.status).toBe(400);
    expect(String(ref.body.error)).toMatch(/own column named file_row_number/);

    // The filter still works: it reads the file's own column, and pages by offset among the matches.
    const where = "file_row_number >= 150";
    const filtered = (await api("/api/rows", { source: own, fingerprint: opened.fingerprint, offset: 3, limit: 3, where })).body as {
      rows: { pos: number | null; cells: string[] }[];
      next: number | null;
      matched: number;
    };
    expect(filtered.matched).toBe(5);
    expect(filtered.rows.map((r) => r.cells[1])).toEqual(["180", "190"]);
    expect(filtered.next).toBeNull();
    const minted = await api("/api/ref", { source: own, fingerprint: opened.fingerprint, ranges: [], where });
    expect(ids(await resolveRef(String(minted.body.ref), { roots: [dir] }))).toEqual([15, 16, 17, 18, 19]);
  });
});
