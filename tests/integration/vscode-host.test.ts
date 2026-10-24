import { copyFileSync, mkdirSync, writeFileSync, readFileSync, realpathSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { resolveRef } from "@fusenduck/core";
import { Host, rootFor, type Reply } from "../../apps/vscode/src/host.ts";
import { csp, messagePage, webviewPage } from "../../apps/vscode/src/html.ts";
import { tempDir, writeCustomers } from "../helpers/fixtures.ts";
import { writeOwnPositionColumn } from "../helpers/web.ts";
import { writeDatabase } from "../helpers/duckdb.ts";

const ids = (out: string) => out.split("\n").filter((l) => l.startsWith("{")).map((l) => Number((JSON.parse(l) as { id: string }).id));

describe("VS Code extension host: the webview's messages (docs/adr/0002)", () => {
  const dir = realpathSync(tempDir());
  const file = join(dir, "customers.parquet");
  const copied: string[] = [];
  const logged: string[] = [];
  let host: Host;
  let id = 0;
  const send = (method: string, params?: Record<string, unknown>) => host.handle({ id: ++id, method, params });
  const result = async <T>(method: string, params?: Record<string, unknown>): Promise<T> => {
    const reply = (await send(method, params)) as Reply;
    if ("error" in reply) throw new Error(reply.error);
    return reply.result as T;
  };
  const make = (path: string) =>
    new Host({ path, roots: [dir], copy: async (text) => void copied.push(text), log: (line) => void logged.push(line) });

  beforeAll(async () => {
    await writeCustomers(file, 1000);
    host = make(file);
  });

  afterAll(async () => {
    await host.close();
  });

  it("opens a CSV file, and a table of a DuckDB file named file#table, but no other file", async () => {
    const csv = join(dir, "t.csv");
    writeFileSync(csv, "id,v\n0,a\n1,b\n");
    const db = join(dir, "t.duckdb");
    await writeDatabase(db);
    const csvHost = make(csv);
    const dbHost = make(db);
    try {
      const reply = (await csvHost.handle({ id: 1, method: "open", params: { path: csv } })) as Reply;
      expect("result" in reply && (reply.result as { kind: string }).kind).toBe("csv");
      const tables = (await dbHost.handle({ id: 2, method: "tables", params: { path: db } })) as Reply;
      expect("result" in tables && (tables.result as { tables: string[] }).tables.sort()).toEqual(["other", "people"]);
      const table = (await dbHost.handle({ id: 3, method: "open", params: { path: `${db}#people` } })) as Reply;
      expect("result" in table && (table.result as { table: string }).table).toBe("people");
      const other = (await dbHost.handle({ id: 4, method: "open", params: { path: `${csv}#people` } })) as Reply;
      expect("error" in other).toBe(true);
    } finally {
      await csvHost.close();
      await dbHost.close();
    }
  });

  it("tells the page its file, opens it, pages rows and mints a Ref that resolves to the selection", async () => {
    expect(await result("init")).toEqual({ path: file });
    const opened = await result<{ source: string; fingerprint: string; ref: string; selectable: boolean }>("open", { path: file });
    expect(opened.source).toBe(file);
    expect(opened.selectable).toBe(true);
    const page = await result<{ rows: { pos: number }[]; next: number }>("rows", { source: file, fingerprint: opened.fingerprint, offset: 100, limit: 5 });
    expect(page.rows.map((r) => r.pos)).toEqual([100, 101, 102, 103, 104]);
    expect(page.next).toBe(105);
    const ref = await result<string>("ref", { source: file, fingerprint: opened.fingerprint, ranges: [[7, 7], [10, 12]] });
    expect(ids(await resolveRef(ref, { roots: [dir] }))).toEqual([8, 11, 12, 13]);
    expect(await result("copy", { text: ref })).toBeNull();
    expect(copied.at(-1)).toBe(ref);
  });

  it("passes a filter and kept columns through to rows and the Ref", async () => {
    const { fingerprint } = await result<{ fingerprint: string }>("open", { path: file });
    const where = "region = 'east'";
    const page = await result<{ rows: { pos: number }[] }>("rows", { source: file, fingerprint, offset: 0, limit: 3, where });
    expect(page.rows.map((r) => r.pos)).toEqual([1, 5, 9]);
    const ref = await result<string>("ref", { source: file, fingerprint, ranges: [], where, columns: ["id"] });
    const out = await resolveRef(ref, { roots: [dir], limit: 3 });
    expect(ids(out)).toEqual([2, 6, 10]);
    expect(out).not.toContain('"region"');
  });

  it("opens only the file of its own editor", async () => {
    const other = join(dir, "other.parquet");
    copyFileSync(file, other);
    expect(await send("open", { path: other })).toEqual({ id, error: "this editor shows one file only; open others from the explorer", changed: false });
  });

  it("puts only a Ref on the clipboard", async () => {
    const before = copied.length;
    expect(await send("copy", { text: "rm -rf /" })).toEqual({ id, error: "only a Ref can be copied", changed: false });
    expect(await send("copy", { text: "fusen://file/x\nrm -rf /" })).toMatchObject({ error: "only a Ref can be copied" });
    expect(copied).toHaveLength(before);
  });

  it("ignores messages that are not requests, and refuses malformed arguments with core's message", async () => {
    for (const message of [null, "open", { id: "1", method: "init" }, { id: 1, method: "eval" }, { id: 1, method: "init", params: [] }]) {
      expect(await host.handle(message)).toBeUndefined();
    }
    const { fingerprint } = await result<{ fingerprint: string }>("open", { path: file });
    const reply = await send("ref", { source: file, fingerprint, ranges: [[5, 2000]] });
    expect(reply).toEqual({ id, error: "a range must lie within positions 0 to 999", changed: false });
  });

  it("withholds an engine message from the page, logs it, and says where the details are", async () => {
    const seen: string[] = [];
    const withheld = new Host({ path: file, roots: [dir], copy: async () => undefined, log: (line) => void seen.push(line), withheld: "See the log." });
    try {
      const opened = (await withheld.handle({ id: 1, method: "open", params: { path: file } })) as { result: { source: string; fingerprint: string } };
      // A filter that fails only while it reads rows: DuckDB's message quotes the cell.
      const reply = (await withheld.handle({
        id: 2,
        method: "rows",
        params: { ...opened.result, offset: 0, limit: 5, where: "CAST(note AS INTEGER) > 0" },
      })) as { error: string };
      expect(reply.error).toMatch(/withheld because they can contain values from the source\. See the log\.$/);
      expect(reply.error).not.toContain("note 1");
      expect(seen).toHaveLength(1);
      expect(seen[0]).not.toContain("note 1");
      expect(seen[0]).toContain("Conversion Error");
      // core's own messages are shown as they are.
      expect(await withheld.handle({ id: 3, method: "copy", params: { text: "x" } })).toMatchObject({ error: "only a Ref can be copied" });
    } finally {
      await withheld.close();
    }
  });

  it("says the file changed instead of selecting other rows, and a reload reads it again", async () => {
    const path = join(dir, "changing.parquet");
    copyFileSync(file, path);
    const changing = make(path);
    try {
      const first = await changing.handle({ id: 1, method: "open", params: { path } });
      const { fingerprint } = (first as { result: { fingerprint: string } }).result;
      await writeCustomers(path, 1001);
      expect(await changing.handle({ id: 2, method: "ref", params: { source: path, fingerprint, ranges: [[7, 7]] } })).toEqual({
        id: 2,
        error: "the file changed since it was opened. Open it again.",
        changed: true,
      });
      const again = (await changing.handle({ id: 3, method: "open", params: { path } })) as { result: { card: { rows: number } } };
      expect(again.result.card.rows).toBe(1001);
    } finally {
      await changing.close();
    }
    expect(await changing.handle({ id: 4, method: "init" })).toEqual({ id: 4, error: "this editor was closed", changed: false });
  });

  it("closing the editor while its file is opening closes the engine that open made", async () => {
    const closing = make(file);
    const opening = closing.handle({ id: 1, method: "open", params: { path: file } });
    await closing.close();
    expect(await opening).toEqual({ id: 1, error: "this editor was closed", changed: false });
  });

  it("a file reached through a symlink opens: the root is the folder of the file it points to", async () => {
    const links = join(dir, "links");
    mkdirSync(links);
    const link = join(links, "linked.parquet");
    symlinkSync(file, link);
    expect(rootFor(link)).toBe(dir);
    const linked = new Host({ path: link, roots: [rootFor(link)], copy: async () => undefined });
    try {
      expect(await linked.handle({ id: 1, method: "open", params: { path: link } })).toMatchObject({ result: { selectable: true } });
    } finally {
      await linked.close();
    }
  });

  it("a file with its own file_row_number column opens, but its rows cannot be selected", async () => {
    const path = join(dir, "own.parquet");
    await writeOwnPositionColumn(path);
    const own = make(path);
    try {
      const opened = (await own.handle({ id: 1, method: "open", params: { path } })) as { result: { selectable: boolean; fingerprint: string } };
      expect(opened.result.selectable).toBe(false);
      const ref = await own.handle({ id: 2, method: "ref", params: { source: path, fingerprint: opened.result.fingerprint, ranges: [[1, 1]] } });
      expect(ref).toMatchObject({ error: expect.stringMatching(/own column named file_row_number/) });
    } finally {
      await own.close();
    }
    expect(logged).toEqual([]);
  });
});

describe("VS Code webview page: the Web UI's page with a webview CSP", () => {
  const template = readFileSync(join(import.meta.dirname, "../../apps/web/spa/index.html"), "utf8");
  const source = "https://file+.vscode-resource.vscode-cdn.net";
  const html = webviewPage({
    template,
    cspSource: source,
    nonce: "n0nce",
    script: `${source}/ext/dist/webview.js`,
    styles: [`${source}/ext/dist/style.css`, `${source}/ext/dist/vscode.css`],
  });

  it("loads scripts only with its nonce, files only from the extension, and fetches nothing", () => {
    expect(csp(source, "n0nce")).toBe(
      `default-src 'none'; script-src 'nonce-n0nce'; style-src ${source}; img-src ${source}; ` +
        "connect-src 'none'; base-uri 'none'; form-action 'none'; require-trusted-types-for 'script'",
    );
    expect(html).toContain(`<meta http-equiv="Content-Security-Policy" content="${csp(source, "n0nce").replaceAll("&", "&amp;")}" />`);
    // The CSP is the first thing in <head>, before any stylesheet or script.
    expect(html.indexOf("Content-Security-Policy")).toBeLessThan(html.indexOf("<link"));
    expect(html).toContain(`<script type="module" nonce="n0nce" src="${source}/ext/dist/webview.js"></script>`);
    expect(html.match(/<script/g)).toHaveLength(1);
    expect(html).not.toMatch(/src="app\.js"|href="style\.css"/);
  });

  it("marks the page as hosted, so the SPA waits for the webview's Api", () => {
    expect(html).toContain('<html lang="en" data-host="vscode">');
    // The Web UI's markup is reused as it is.
    expect(html).toContain('<form id="open-form">');
  });

  it("shows a message page that runs and loads nothing, with its text escaped", () => {
    const page = messagePage("cannot open <b>", 'a "file" & <script>x</script>');
    expect(page).toContain(`content="default-src 'none'"`);
    expect(page).toContain("cannot open &lt;b&gt;");
    expect(page).toContain("&lt;script&gt;x&lt;/script&gt;");
    expect(page).not.toMatch(/<script|<link|<img/);
  });

  it("fails loudly when the Web UI's page no longer has a tag it swaps", () => {
    expect(() => webviewPage({ template: template.replace('src="app.js"', 'src="main.js"'), cspSource: source, nonce: "n", script: "s", styles: [] })).toThrow(
      /index\.html/,
    );
  });
});
