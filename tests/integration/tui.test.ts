import { join } from "node:path";
import { DuckDBInstance } from "@duckdb/node-api";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { resolveRef } from "@fusenduck/core";
import { View } from "../../apps/web/src/view.ts";
import { Selection } from "../../apps/tui/src/selection.ts";
import { plain } from "../../apps/tui/src/text.ts";
import { tempDir, writeCustomers } from "../helpers/fixtures.ts";
import { KEY, driveTui } from "../helpers/tui.ts";
import { writeOwnPositionColumn } from "../helpers/web.ts";

const ids = (out: string) => out.split("\n").filter((l) => l.startsWith("{")).map((l) => Number((JSON.parse(l) as { id: string }).id));

describe("TUI: pick rows and copy a Ref (docs/adr/0003)", () => {
  const dir = tempDir();
  const file = join(dir, "customers.parquet");
  const opened: View[] = [];
  let stop = () => {};
  beforeAll(() => writeCustomers(file, 1000));
  afterEach(async () => {
    stop();
    await Promise.all(opened.splice(0).map((v) => v.close()));
  });
  const start = async (path = file) => {
    const view = await View.open(path, [dir]);
    opened.push(view);
    const tui = driveTui(view);
    stop = tui.stop;
    await tui.until((s) => s.includes("\n> 0"), "the first page");
    return { view, ...tui };
  };

  it("copies a Ref that returns exactly the rows picked with space and v", async () => {
    const t = await start();
    // Pick row 0 and row 2, then a range of rows 4..6 with v.
    await t.press(" ");
    await t.press(KEY.down, KEY.down, " ");
    await t.press(KEY.down, KEY.down, "v");
    await t.press(KEY.down, KEY.down);
    await t.until((s) => s.includes("5 picked"), "five rows picked");
    await t.press("y");
    await t.until(() => t.copied.length === 1, "a copy");
    // The ids are the 1-based values of positions 0, 2, 4, 5, 6.
    expect(ids(await resolveRef(t.copied[0]!, { roots: [dir] }))).toEqual([1, 3, 5, 6, 7]);
    await t.press("q");
    await t.until(() => t.done.length === 1, "quit");
    expect(t.done[0]).toBe(t.copied[0]);
  });

  it("filters with a condition and copies the Ref for the rows that pass", async () => {
    const t = await start();
    await t.press("/");
    await t.press("id > 990");
    await t.press(KEY.enter);
    await t.until((s) => s.includes("10 rows match"), "ten rows matching");
    await t.press("y");
    await t.until(() => t.copied.length === 1, "a copy");
    expect(ids(await resolveRef(t.copied[0]!, { roots: [dir] }))).toEqual(Array.from({ length: 10 }, (_, i) => 991 + i));
  });

  it("shows core's wording for a bad filter and goes back to the unfiltered table", async () => {
    const t = await start();
    await t.press("/");
    await t.press("nosuch > 1");
    await t.press(KEY.enter);
    const screen = await t.until((s) => s.includes('no column named "nosuch"'), "the filter error");
    expect(screen).toContain("filter: (none)");
  });

  it("pages forward and back, and a pick on the second page is a position in the file", async () => {
    const t = await start();
    await t.press("n");
    await t.until((s) => /\n[> ] ?\s?(\d{2,3}) /.test(s) && !s.includes("\n>  0 "), "the second page");
    await t.press(" ");
    await t.press("y");
    await t.until(() => t.copied.length === 1, "a copy");
    const got = ids(await resolveRef(t.copied[0]!, { roots: [dir] }));
    expect(got).toHaveLength(1);
    expect(got[0]).toBeGreaterThan(1);
    await t.press("p");
    await t.until((s) => s.includes("> ") && s.includes(" 1 "), "the first page again");
  });

  it("refuses to pick when the file has its own file_row_number column", async () => {
    const own = join(dir, "own.parquet");
    await writeOwnPositionColumn(own);
    const view = await View.open(own, [dir]);
    opened.push(view);
    const t = driveTui(view);
    stop = t.stop;
    await t.until((s) => s.includes("\n> "), "the first page");
    await t.press(" ");
    await t.until((s) => s.includes("cannot be picked"), "the refusal");
    expect(t.frame()).toContain("0 picked");
  });

  it("says the file changed instead of copying a Ref for different rows", async () => {
    const mine = join(dir, "changing.parquet");
    await writeCustomers(mine, 50);
    const t = await start(mine);
    await writeCustomers(mine, 60);
    await t.press(" ");
    await t.until((s) => s.includes("the file changed since it was opened"), "the changed notice");
    await t.press("y");
    await new Promise((r) => setTimeout(r, 300));
    expect(t.copied).toEqual([]);
  });

  it("prints cells and names that carry terminal escapes as placeholders, never as escapes", async () => {
    const hostile = join(dir, "hostile.parquet");
    const connection = await (await DuckDBInstance.create(":memory:")).connect();
    // A cell with a title-setting OSC, a clipboard-setting OSC 52, a CSI that erases the screen, a bell and a bidi override.
    const esc = String.fromCharCode(27);
    const cell = `${esc}]0;owned${String.fromCharCode(7)}${esc}]52;c;cGF5bG9hZA==${String.fromCharCode(7)}${esc}[2J${String.fromCharCode(0x202e)}evil`;
    await connection.run(`COPY (SELECT 1 AS id, '${cell}' AS note, 2 AS "c${esc}[31mol") TO '${hostile}' (FORMAT parquet)`);
    const view = await View.open(hostile, [dir]);
    opened.push(view);
    const t = driveTui(view);
    stop = t.stop;
    await t.until((s) => s.includes("owned"), "the hostile row");
    const screen = t.chunks.join("");
    // The only escapes on screen are the ones ink wrote for colour and inverse video (CSI … m).
    // eslint-disable-next-line no-control-regex -- the test looks for control characters
    expect(screen.replace(/\u001b\[[0-9;]*m/g, "")).not.toMatch(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f‮]/);
    expect(screen).toContain("�");
  });
});

describe("TUI: text and selection helpers", () => {
  it("plain shows controls, bidi overrides and line breaks as placeholders", () => {
    expect(plain("a\u001b[2Jb\u0007c‮d")).toBe("a�[2Jb�c�d");
    expect(plain("one\ntwo\r\nthree\tfour")).toBe("one⏎two⏎⏎three four");
    expect(plain("日本語 ok")).toBe("日本語 ok");
  });

  it("Selection merges touching positions into ranges and toggles", () => {
    const s = new Selection();
    s.toggle(5);
    s.addRange(3, 1);
    s.toggle(4);
    s.toggle(9);
    expect(s.ranges()).toEqual([[1, 5], [9, 9]]);
    s.toggle(3);
    expect(s.ranges()).toEqual([[1, 2], [4, 5], [9, 9]]);
    expect(s.size).toBe(5);
    s.clear();
    expect(s.ranges()).toEqual([]);
  });
});
