/// <reference lib="dom" />
// The VS Code webview in a real Chromium: the page the extension builds (apps/vscode/dist), its CSP,
// and the extension host's message handling (apps/vscode/src/host.ts), joined the way VS Code joins
// them: the page posts with acquireVsCodeApi().postMessage, and replies arrive as message events.
// VS Code itself is not started; the webview's own origin is stood in for by a routed one.
import { execFileSync } from "node:child_process";
import { copyFileSync, readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { chromium, type Browser, type Page } from "playwright-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { resolveRef } from "@fusenduck/core";
import { Host, rootFor } from "../../apps/vscode/src/host.ts";
import { webviewPage } from "../../apps/vscode/src/html.ts";
import { tempDir, writeCustomers } from "../helpers/fixtures.ts";
import { HOSTILE_CELLS, writeHostileMarkup } from "../helpers/web.ts";

const ext = join(import.meta.dirname, "../../apps/vscode");
const dist = join(ext, "dist");
const origin = "https://webview.test";
const ids = (out: string) => out.split("\n").filter((l) => l.startsWith("{")).map((l) => Number((JSON.parse(l) as { id: string }).id));
const types: Record<string, string> = { js: "text/javascript", css: "text/css" };

describe("VS Code webview in Chromium", () => {
  const dir = realpathSync(tempDir());
  const customers = join(dir, "customers.parquet");
  let browser: Browser;
  const console: string[] = [];
  const pages: { page: Page; host: Host; copied: string[] }[] = [];

  /** Opens `path` in a webview the way the extension's editor does. */
  async function editor(path: string): Promise<{ page: Page; copied: string[] }> {
    const copied: string[] = [];
    const host = new Host({ path, roots: [rootFor(path)], copy: async (text) => void copied.push(text) });
    const page = await browser.newPage();
    page.on("console", (m) => console.push(m.text()));
    const html = webviewPage({
      template: readFileSync(join(dist, "index.html"), "utf8"),
      cspSource: origin,
      nonce: "test-nonce",
      script: `${origin}/webview.js`,
      styles: [`${origin}/style.css`, `${origin}/vscode.css`],
    });
    await page.route(`${origin}/**`, (route) => {
      const name = new URL(route.request().url()).pathname.slice(1);
      if (name === "") return route.fulfill({ contentType: "text/html", body: html });
      return route.fulfill({ contentType: types[name.split(".").pop()!] ?? "text/plain", body: readFileSync(join(dist, name)) });
    });
    await page.exposeBinding("__toHost", async ({ page }, message: unknown) => {
      const reply = await host.handle(message);
      if (reply) await page.evaluate((r) => window.postMessage(r, "*"), reply);
    });
    // VS Code puts acquireVsCodeApi in the webview before the page's own scripts run.
    await page.addInitScript(() => {
      const send = (window as unknown as { __toHost(m: unknown): void }).__toHost;
      (window as unknown as { acquireVsCodeApi(): unknown }).acquireVsCodeApi = () => ({ postMessage: (m: unknown) => send(m) });
    });
    await page.goto(`${origin}/`);
    await page.waitForSelector("#rows tbody tr");
    pages.push({ page, host, copied });
    return { page, copied };
  }

  beforeAll(async () => {
    execFileSync(process.execPath, [join(ext, "build.ts")], { stdio: "inherit" });
    await writeCustomers(customers, 1000);
    browser = await chromium.launch();
  });

  afterAll(async () => {
    await browser?.close();
    for (const { host } of pages) await host.close();
  });

  it("opens its file at once, and a Shift range copied through the host resolves to exactly those rows", async () => {
    const { page, copied } = await editor(customers);
    expect(await page.inputValue("#path")).toBe(customers);
    expect(await page.textContent("#open")).toBe("Reload");
    expect(await page.textContent("#source")).toBe(`${customers} — 1000 rows`);
    expect(await page.locator("#rows tbody tr").count()).toBe(100);

    await page.locator('#rows tbody tr[data-pos="3"]').click();
    await page.locator('#rows tbody tr[data-pos="6"]').click({ modifiers: ["Shift"] });
    // Copy right after the click: Copy waits for the newest Ref.
    await page.click("#copy");
    await page.waitForFunction(() => /^Copied the Ref for 4 selected rows/.test(document.getElementById("status")?.textContent ?? ""));
    expect(copied).toHaveLength(1);
    expect(ids(await resolveRef(copied[0]!, { roots: [dir] }))).toEqual([4, 5, 6, 7]);
  });

  it("after the file changes, says so, and Reload reads it again", async () => {
    const path = join(dir, "changing.parquet");
    copyFileSync(customers, path);
    const { page, copied } = await editor(path);
    await writeCustomers(path, 1001);
    await page.locator('#rows tbody tr[data-pos="7"]').click();
    await page.waitForFunction(() => document.getElementById("status")?.classList.contains("error"));
    expect(await page.textContent("#status")).toBe("The file changed since it was opened. Open it again.");
    await page.click("#copy");
    expect(copied).toEqual([]);
    await page.click("#open");
    await page.waitForFunction(() => /1001 rows$/.test(document.getElementById("source")?.textContent ?? ""));
    await page.locator('#rows tbody tr[data-pos="7"]').click();
    await page.click("#copy");
    await page.waitForFunction(() => /^Copied/.test(document.getElementById("status")?.textContent ?? ""));
    expect(ids(await resolveRef(copied[0]!, { roots: [dir] }))).toEqual([8]);
  });

  it("markup in cells shows as text and runs nothing; the page can neither fetch nor assign markup", async () => {
    const path = join(dir, "hostile.parquet");
    await writeHostileMarkup(path);
    const { page } = await editor(path);
    const notes = await page.locator("#rows tbody tr td:nth-child(3)").allTextContents();
    expect(notes.slice(3, 5)).toEqual(HOSTILE_CELLS);
    expect(await page.locator("img").count()).toBe(0);
    expect(await page.evaluate(() => (window as unknown as { __pwned?: number }).__pwned)).toBeUndefined();
    const refused = await page.evaluate(async () => {
      const markup = (() => {
        try {
          document.body.insertAdjacentHTML("beforeend", "<b>x</b>");
          return "assigned";
        } catch (error) {
          return (error as Error).name;
        }
      })();
      const fetched = await fetch("https://webview.test/style.css").then(
        () => "fetched",
        (error: Error) => error.name,
      );
      return { markup, fetched };
    });
    expect(refused).toEqual({ markup: "TypeError", fetched: "TypeError" });
    expect(console.join("\n")).toMatch(/Refused to connect to 'https:\/\/webview\.test\/style\.css'.*connect-src 'none'/);
  });

  it("logged no other CSP violation: the page's own script and styles load under the CSP", () => {
    const deliberate = (m: string) => m.includes("https://webview.test/style.css") && !/style-src/.test(m);
    expect(console.filter((m) => /Content Security Policy|Trusted Type/i.test(m) && !deliberate(m))).toEqual([]);
  });
});
