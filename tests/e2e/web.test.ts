/// <reference lib="dom" />
// The Web UI in a real Chromium (docs/adr/0002, acceptance 1, 2, 4, 5, 6 and 7): select rows, copy
// the Ref, and check that resolving it returns exactly the rows that were selected.
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { copyFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { resolveRef } from "@fusenduck/core";
import { startWebServer, type WebHandle } from "../../apps/web/src/server.ts";
import { tempDir, writeCustomers } from "../helpers/fixtures.ts";
import { buildSpa, HOSTILE_CELLS, writeHostileMarkup, writeOwnPositionColumn } from "../helpers/web.ts";

const ids = (out: string) => out.split("\n").filter((l) => l.startsWith("{")).map((l) => Number((JSON.parse(l) as { id: string }).id));
const range = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => from + i);

describe("Web UI in Chromium", () => {
  // The page shows real paths (macOS puts temp files under a symlink).
  const dir = realpathSync(tempDir());
  const customers = join(dir, "customers.parquet");
  let handle: WebHandle;
  let origin: string;
  let browser: Browser;
  let context: BrowserContext;
  let page: Page;
  const console: string[] = [];

  const open = async (path: string) => {
    await page.fill("#path", path);
    await page.click("#open");
    await page.waitForFunction((p) => document.getElementById("source")?.textContent?.startsWith(p), path);
    await page.waitForSelector("#rows tbody tr");
  };
  const row = (pos: number) => page.locator(`#rows tbody tr[data-pos="${pos}"]`);
  // Copy right after the click, without waiting for the Ref field: Copy must wait for the newest Ref.
  const copy = async () => {
    await page.click("#copy");
    await page.waitForFunction(() => /^Copied/.test(document.getElementById("status")?.textContent ?? ""));
    const text = await page.evaluate(() => navigator.clipboard.readText());
    await page.evaluate(() => {
      document.getElementById("status")!.textContent = "";
    });
    return text;
  };
  const resolved = async (ref: string) => ids(await resolveRef(ref, { roots: [dir], limit: 1000 }));

  beforeAll(async () => {
    buildSpa();
    await writeCustomers(customers, 1000);
    handle = await startWebServer({ roots: [dir] });
    origin = new URL(handle.url).origin;
    browser = await chromium.launch();
    context = await browser.newContext();
    await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin });
    page = await context.newPage();
    page.on("console", (m) => console.push(m.text()));
    await page.goto(handle.url);
    await page.waitForFunction(() => !location.hash);
  });

  afterAll(async () => {
    await browser?.close();
    await handle?.close();
  });

  it("removes the code from the address bar and keeps the token in this tab", async () => {
    expect(page.url()).toBe(`${origin}/`);
    expect(await page.evaluate(() => sessionStorage.getItem("fusenduck-token"))).toMatch(/^[\w-]{43}$/);
  });

  it("1 and 6: a row, a Shift range, a Ctrl addition and a row on page 2 each copy a Ref that resolves to exactly those rows", async () => {
    await open(customers);
    expect(await page.locator("#rows tbody tr").count()).toBe(100);

    // Nothing selected: the Ref is the whole file.
    expect(await resolved(await copy())).toHaveLength(1000);

    await row(7).click();
    expect(await resolved(await copy())).toEqual([8]);

    await row(10).click();
    await row(14).click({ modifiers: ["Shift"] });
    expect(await resolved(await copy())).toEqual(range(11, 15));

    await row(20).click();
    await row(22).click({ modifiers: ["Shift"] });
    await row(40).click({ modifiers: ["ControlOrMeta"] });
    const union = await copy();
    expect(decodeURIComponent(union)).toContain("where=file_row_number BETWEEN 20 AND 22 OR file_row_number = 40");
    expect(await resolved(union)).toEqual([21, 22, 23, 41]);

    // Ctrl on a selected row takes it out again.
    await row(21).click({ modifiers: ["ControlOrMeta"] });
    expect(await resolved(await copy())).toEqual([21, 23, 41]);

    await page.click("#next");
    await row(150).waitFor();
    await row(150).click();
    expect(await resolved(await copy())).toEqual([151]);

    // A Shift range that crosses pages, from page 2 back to page 1.
    await page.click("#prev");
    await row(95).click({ modifiers: ["Shift"] });
    expect(await resolved(await copy())).toEqual(range(96, 151));
    await expect.poll(() => page.locator("#rows tr.selected").count()).toBe(5);
  });

  it("columns left out and a filter: the table shows what the Ref covers, and Copy gives exactly that", async () => {
    await open(customers);
    await page.locator('#card input[data-column="region"]').uncheck();
    await page.locator('#card input[data-column="status"]').uncheck();
    expect(await page.locator("#rows thead th").allTextContents()).toEqual(["#", "id", "amount", "note"]);
    expect(await page.locator("#keep-all input").evaluate((box: HTMLInputElement) => box.indeterminate)).toBe(true);
    const columnsOnly = await copy();
    expect(columnsOnly).toContain("cols=id,amount,note");
    expect(await resolved(columnsOnly)).toHaveLength(1000);

    await page.fill("#filter", "region = 'south' AND id <= 40");
    await page.press("#filter", "Enter");
    await page.waitForFunction(() => /10 of 1000 rows match/.test(document.getElementById("status")?.textContent ?? ""));
    expect(await page.locator("#rows tbody tr").count()).toBe(10);
    expect(await page.textContent("#page")).toBe("rows 1–10 of 10 matching the filter (1000 in the file)");
    expect(await page.textContent("#selection")).toMatch(/^The Ref covers the rows that match the filter, 3 of 5 columns \(id, amount, note\)\./);
    const filtered = await copy();
    expect(decodeURIComponent(filtered)).toContain("cols=id,amount,note&where=region = 'south' AND id <= 40");
    expect(await resolved(filtered)).toEqual(range(0, 9).map((i) => 1 + 4 * i));

    // A row picked among the matches is named by its position.
    await row(8).click();
    expect(await resolved(await copy())).toEqual([9]);

    // A bad filter says why and leaves the rows and the filter that was applied.
    await page.fill("#filter", "amont > 1");
    await page.click("#filter-form button[type=submit]");
    await page.waitForFunction(() => document.getElementById("status")?.classList.contains("error"));
    expect(await page.textContent("#status")).toMatch(/^Filter rejected: .*amont/);
    expect(await page.getAttribute("#filter", "aria-invalid")).toBe("true");
    expect(await page.locator("#rows tbody tr").count()).toBe(10);

    // Clear goes back to every row; ticking "all" keeps every column again.
    await page.click("#clear-filter");
    await page.waitForFunction(() => document.querySelectorAll("#rows tbody tr").length === 100);
    await page.locator("#keep-all input").check();
    expect(await page.locator("#rows thead th").count()).toBe(6);
    expect(await resolved(await copy())).toHaveLength(1000);
  });

  it("6: a click followed at once by another click and Copy copies the newest selection", async () => {
    await open(customers);
    // Slow the mints down so Copy is pressed while they are still running; the first one is the slowest.
    let delay = 600;
    await page.route("**/api/ref", async (route) => {
      const wait = delay;
      delay = Math.max(50, delay - 300);
      await new Promise((resolve) => setTimeout(resolve, wait));
      await route.continue();
    });
    try {
      for (let i = 0; i < 3; i++) {
        delay = 600;
        await row(3).click();
        await row(60 + i).click();
        expect(await resolved(await copy())).toEqual([61 + i]);
      }
    } finally {
      // The slow mint of row 3 may still be waiting; let it finish before the route goes.
      await page.unrouteAll({ behavior: "wait" });
    }
  });

  it("2: after the file changes, selecting a row makes no Ref and says the file changed", async () => {
    const path = join(dir, "changing.parquet");
    copyFileSync(customers, path);
    await open(path);
    await page.evaluate(() => navigator.clipboard.writeText("before"));
    await writeCustomers(path, 1001);
    await row(7).click();
    await page.waitForFunction(() => document.getElementById("status")?.classList.contains("error"));
    expect(await page.textContent("#status")).toBe("The file changed since it was opened. Open it again.");
    expect(await page.inputValue("#ref")).toBe("");
    await page.click("#copy");
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe("before");
  });

  it("4: markup in cells and in the card shows as text and runs nothing", async () => {
    const path = join(dir, "hostile.parquet");
    await writeHostileMarkup(path);
    await open(path);
    const notes = await page.locator("#rows tbody tr td:nth-child(3)").allTextContents();
    expect(notes.slice(3, 5)).toEqual(HOSTILE_CELLS);
    // The min of the note column in the card is the script one (cut to 40 characters by core).
    const card = await page.locator("#card").textContent();
    expect(card).toContain(`${HOSTILE_CELLS[1]!.slice(0, 40)}…`);
    expect(await page.locator("img").count()).toBe(0);
    expect(await page.locator("#rows script, #card script").count()).toBe(0);
    expect(await page.evaluate(() => (window as unknown as { __pwned?: number }).__pwned)).toBeUndefined();
    // The CSP makes the browser refuse markup assigned as a string.
    const refused = await page.evaluate(() => {
      try {
        document.body.insertAdjacentHTML("beforeend", "<b>x</b>");
        return "assigned";
      } catch (error) {
        return (error as Error).name;
      }
    });
    expect(refused).toBe("TypeError");
  });

  it("5: a page on another origin cannot frame the UI (CSP frame-ancestors)", async () => {
    const evil: Server = createServer((_, res) => {
      res.writeHead(200, { "content-type": "text/html" });
      res.end(`<iframe src="${origin}/"></iframe>`);
    });
    await new Promise<void>((resolve) => evil.listen(0, "127.0.0.1", resolve));
    const other = await browser.newPage();
    const messages: string[] = [];
    other.on("console", (m) => messages.push(m.text()));
    try {
      // localhost is a different origin from 127.0.0.1.
      await other.goto(`http://localhost:${(evil.address() as AddressInfo).port}/`);
      await expect.poll(() => messages.join("\n")).toMatch(/frame-ancestors 'none'/);
      expect(messages.find((m) => m.includes("frame-ancestors"))).toMatch(/^Refused to frame/);
      // The frame shows Chromium's error page, not the UI.
      const frame = other.frames().find((f) => f !== other.mainFrame());
      expect(await frame?.locator("#open-form").count().catch(() => 0)).toBe(0);
    } finally {
      await other.close();
      await new Promise((resolve) => evil.close(resolve));
    }
  });

  it("7: a file with its own file_row_number column says rows cannot be selected, and Copy gives the whole file", async () => {
    const path = join(dir, "own.parquet");
    await writeOwnPositionColumn(path);
    await page.fill("#path", path);
    await page.click("#open");
    await page.waitForFunction(() => /cannot be selected/.test(document.getElementById("selection")?.textContent ?? ""));
    expect(await page.textContent("#status")).toBe("Rows of this file cannot be selected: see below.");
    expect(await page.locator("#rows tbody tr").count()).toBe(20);
    await page.locator("#rows tbody tr").nth(2).click();
    expect(await page.locator("#rows tr.selected").count()).toBe(0);
    const ref = await copy();
    expect(decodeURIComponent(ref)).not.toContain("where=");
    expect(await resolved(ref)).toEqual(range(0, 19));

    // The filter still picks rows here, through the file's own column.
    await page.fill("#filter", "file_row_number >= 150");
    await page.press("#filter", "Enter");
    await page.waitForFunction(() => document.querySelectorAll("#rows tbody tr").length === 5);
    expect(await resolved(await copy())).toEqual(range(15, 19));
  });

  it("logged no CSP violation on its own page", () => {
    expect(console.filter((m) => /Content Security Policy|Trusted Type/i.test(m))).toEqual([]);
  });
});
