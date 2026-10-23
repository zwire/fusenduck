import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
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

  it("goes back to the filter that worked when a later one fails, and keeps the failure's message", async () => {
    const t = await start();
    await t.press("/", "id > 990", KEY.enter);
    await t.until((s) => s.includes("10 rows match"), "the first filter");
    await t.press("/");
    for (let i = 0; i < "id > 990".length; i++) await t.press(KEY.backspace);
    await t.press("nosuch > 1", KEY.enter);
    const screen = await t.until((s) => s.includes('no column named "nosuch"') && s.includes("10 rows match"), "the failure with the first filter back");
    expect(screen).toContain("filter: id > 990");
  });

  it("clears the picks when the filter changes, so the count is what the Ref returns", async () => {
    const t = await start();
    await t.press(" ");
    await t.until((s) => s.includes("1 picked"), "one pick");
    await t.press("/", "id > 90", KEY.enter);
    // Wait for the filtered page itself: a pick made before it loads lands on the old page's row.
    await t.until((s) => s.includes("0 picked") && s.includes("were cleared") && s.includes("910 rows match") && s.includes("\n> 90 "), "the picks cleared and the filtered page");
    await t.press(" ", "y");
    await t.until(() => t.copied.length === 1, "a copy");
    expect(ids(await resolveRef(t.copied[0]!, { roots: [dir] }))).toEqual([91]);
  });

  it("keeps only the chosen columns in the table and the Ref, with the picked rows", async () => {
    const t = await start();
    await t.press(" ");
    // Drop amount, status and note: the chooser starts on id.
    await t.press("c");
    await t.until((s) => s.includes("[x] id") && s.includes("5 of 5 kept"), "the chooser");
    await t.press(KEY.down, KEY.down, " ", KEY.down, " ", KEY.down, " ");
    await t.until((s) => s.includes("2 of 5 kept") && s.includes("[ ] note"), "three columns dropped");
    await t.press(KEY.enter);
    const screen = await t.until((s) => s.includes("2 of 5 columns") && s.includes("1 picked"), "the table with two columns");
    const header = screen.split("\n").find((l) => l.startsWith("#"))!;
    expect(header).not.toContain("amount");
    expect(header).toContain("region");
    await t.press("y");
    await t.until(() => t.copied.length === 1, "a copy");
    const out = (await resolveRef(t.copied[0]!, { roots: [dir] })).split("\n").filter((l) => l.startsWith("{"));
    expect(out).toHaveLength(1);
    expect(Object.keys(JSON.parse(out[0]!) as object)).toEqual(["id", "region"]);
    // Keeping all again goes back to the Ref for the picked rows alone.
    await t.press("c", "a", KEY.enter);
    await t.until((s) => s.includes("5 columns") && s.includes("amount"), "all columns back");
  });

  it("copies only the kept columns of the whole file when nothing is picked", async () => {
    const t = await start();
    await t.press("c", " ");
    await t.press(KEY.enter);
    await t.until((s) => s.includes("4 of 5 columns") && !(s.split("\n").find((l) => l.startsWith("#")) ?? "").includes("id"), "id dropped");
    await t.press("y");
    await t.until(() => t.copied.length === 1, "a copy");
    const out = (await resolveRef(t.copied[0]!, { roots: [dir] })).split("\n").filter((l) => l.startsWith("{"));
    // The Ref names the whole file; resolving it previews the first 100 rows.
    expect(out).toHaveLength(100);
    expect(Object.keys(JSON.parse(out[0]!) as object)).toEqual(["region", "amount", "status", "note"]);
  });

  it("refuses to drop the last column", async () => {
    const t = await start();
    await t.press("c");
    for (let i = 0; i < 4; i++) await t.press(KEY.down, " ");
    await t.until((s) => s.includes("1 of 5 kept"), "one column left");
    await t.press(KEY.up, KEY.up, KEY.up, KEY.up);
    // The cursor is on id again; it is the only one kept.
    await t.press(" ");
    await t.until((s) => s.includes("keep at least one column") && s.includes("1 of 5 kept"), "the refusal");
  });

  it("quits on Ctrl-C even while a filter is being typed", async () => {
    const t = await start();
    await t.press("/", "id >");
    await t.press("\u0003");
    await t.until(() => t.done.length === 1, "quit");
  });

  it("pages forward and back, and a pick on the second page is a position in the file", async () => {
    const t = await start();
    await t.press("n");
    await t.until((s) => /\n[> ] ?\s?(\d{2,3}) /.test(s) && !s.includes("\n>  0 "), "the second page");
    await t.press(" ");
    await t.press("y");
    await t.until(() => t.copied.length === 1, "a copy");
    const got = ids(await resolveRef(t.copied[0]!, { roots: [dir] }));
    // 24 terminal rows leave 16 table rows, so the second page starts at position 16 (id 17).
    expect(got).toEqual([17]);
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

describe("TUI: pick a file from the roots", () => {
  const dir = tempDir();
  const outside = tempDir();
  let stop = () => {};
  let tracked: View[] = [];
  beforeAll(async () => {
    mkdirSync(join(dir, "sub"));
    mkdirSync(join(dir, ".hidden"));
    await writeCustomers(join(dir, "a.parquet"), 30);
    await writeCustomers(join(dir, "sub", "b.parquet"), 40);
    await writeCustomers(join(dir, ".hidden", "c.parquet"), 5);
    await writeCustomers(join(outside, "secret.parquet"), 5);
    symlinkSync(join(outside, "secret.parquet"), join(dir, "link.parquet"));
    writeFileSync(join(dir, "broken.parquet"), "not parquet");
    // A name that carries a terminal escape.
    await writeCustomers(join(dir, `esc${String.fromCharCode(27)}[2Jx.parquet`), 5);
  });
  afterEach(async () => {
    stop();
    await Promise.all(tracked.splice(0).map((v) => v.close()));
  });
  const startList = async () => {
    const tui = driveTui(null, undefined, [dir]);
    stop = tui.stop;
    tracked = tui.tracked;
    await tui.until((s) => s.includes("Parquet files"), "the list");
    return tui;
  };

  it("lists the files under the roots without hidden files and links, then opens the picked one", async () => {
    const t = await startList();
    const screen = await t.until((s) => s.includes("sub/b.parquet"), "the nested file");
    expect(screen).toContain("a.parquet");
    expect(screen).not.toContain("c.parquet");
    expect(screen).not.toContain("link.parquet");
    expect(screen).not.toContain("secret");
    // Sorted: a, broken, esc…, sub/b.
    await t.press(KEY.down, KEY.down, KEY.down, KEY.enter);
    await t.until((s) => s.includes("40 rows"), "the nested file's table");
    await t.press(" ", "y");
    await t.until(() => t.copied.length === 1, "a copy");
    expect(await resolveRef(t.copied[0]!, { roots: [dir] })).toContain('"id"');
    expect(t.tracked).toHaveLength(1);
  });

  it("goes back to the list with b and opens another file", async () => {
    const t = await startList();
    await t.until((s) => s.includes("a.parquet"), "the list");
    await t.press(KEY.enter);
    await t.until((s) => s.includes("\n> 0"), "the first table");
    await t.press("b");
    await t.until((s) => s.includes("pick a file"), "the list again");
    await t.press("j", "j", KEY.enter);
    await t.until((s) => s.includes("\n> 0") && s.includes("5 rows, 5 columns"), "the second table");
    expect(t.tracked).toHaveLength(2);
    await t.press("q");
    await t.until(() => t.done.length === 1, "quit");
  });

  it("shows core's wording when a file does not open, and stays on the list", async () => {
    const t = await startList();
    await t.until((s) => s.includes("broken.parquet"), "the list");
    await t.press(KEY.down, KEY.enter);
    const screen = await t.until((s) => s.includes("pick a file") && !s.includes("opening…") && /not|cannot|could/i.test(s.split("\n").slice(-3).join("\n")), "an error line");
    expect(screen).toContain("broken.parquet");
  });

  it("prints a file name that carries an escape as a placeholder", async () => {
    const t = await startList();
    await t.until((s) => s.includes("esc"), "the escape name");
    const screen = t.chunks.join("");
    // eslint-disable-next-line no-control-regex -- the test looks for control characters
    expect(screen.replace(/\u001b\[[0-9;]*m/g, "")).not.toMatch(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/);
    expect(screen).toContain("esc�[2Jx.parquet");
  });

  it("quits from the list with nothing to print", async () => {
    const t = await startList();
    await t.press("q");
    await t.until(() => t.done.length === 1, "quit");
    expect(t.done[0]).toBeUndefined();
  });
});

describe("TUI: text and selection helpers", () => {
  it("plain shows controls, bidi overrides and line breaks as placeholders", () => {
    expect(plain("a\u001b[2Jb\u0007c‮d")).toBe("a�[2Jb�c�d");
    expect(plain("one\ntwo\r\nthree\tfour")).toBe("one⏎two⏎⏎three four");
    expect(plain("日本語 ok")).toBe("日本語 ok");
    // Invisible characters that can hide text or reorder it.
    expect(plain("a\u200bb\u061cc\ufeffd\u{e0041}e")).toBe("a\uFFFDb\uFFFDc\uFFFDd\uFFFDe");
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
