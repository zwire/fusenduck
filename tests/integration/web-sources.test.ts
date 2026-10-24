import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { parseRef, resolveRef } from "@fusenduck/core";
import { layoutPredicate, tablesOf, View } from "../../apps/web/src/view.ts";
import { listFiles } from "../../apps/web/src/files.ts";
import { tempDir } from "../helpers/fixtures.ts";
import { writeDatabase } from "../helpers/duckdb.ts";

const ids = (out: string) => out.split("\n").filter((l) => l.startsWith("{")).map((l) => Number((JSON.parse(l) as { id: string }).id));

describe("the Web UI's view of sources other than one Parquet file", () => {
  const dir = tempDir();

  beforeAll(() => {
    writeFileSync(join(dir, "a.csv"), "id,name\n0,a0\n1,a1\n2,a2\n");
    writeFileSync(join(dir, "b.csv"), "id,name\n3,b0\n4,b1\n");
    writeFileSync(join(dir, "c.csv"), "id,name\n5,c0\n6,c1\n7,c2\n8,c3\n");
    writeFileSync(join(dir, "rows.ndjson"), [0, 1, 2, 3].map((i) => JSON.stringify({ id: i, tag: `t${i}` })).join("\n") + "\n");
    writeFileSync(join(dir, "rows.json"), JSON.stringify([0, 1, 2].map((i) => ({ id: i, tag: `j${i}` }))));
  });

  it("lists every kind it can open, with the kind its name says", async () => {
    await writeDatabase(join(dir, "people.duckdb"), { onlyPeople: true });
    writeFileSync(join(dir, "notes.txt"), "not a source");
    const listed = await listFiles([dir]);
    const kinds = Object.fromEntries(listed.roots[0]!.files.map((f) => [f.name, f.kind]));
    expect(kinds).toMatchObject({ "a.csv": "csv", "rows.ndjson": "ndjson", "rows.json": "json", "people.duckdb": "duckdb" });
    expect(kinds["notes.txt"]).toBeUndefined();
  });

  it.each([
    ["a CSV file", "a.csv", "csv", 3],
    ["an NDJSON file", "rows.ndjson", "ndjson", 4],
    ["a JSON file", "rows.json", "json", 3],
  ])("opens %s, pages it, and selects rows by position", async (_name, file, kind, rows) => {
    const view = await View.open(join(dir, file), [dir]);
    try {
      expect(view.opened).toMatchObject({ kind, selectable: true, files: 1 });
      expect(view.opened.card.rows).toBe(rows);
      const page = await view.rows(view.opened.fingerprint, 0, 100);
      expect(page.rows.map((r) => r.pos)).toEqual(Array.from({ length: rows }, (_, i) => i));
      const filtered = await view.rows(view.opened.fingerprint, 0, 100, "id >= 1");
      expect(filtered.rows.map((r) => r.pos)).toEqual(Array.from({ length: rows - 1 }, (_, i) => i + 1));
      const ref = await view.ref(view.opened.fingerprint, [[1, 2]]);
      expect(parseRef(ref).src).toBe(kind);
      expect(ids(await resolveRef(ref, { roots: [dir] }))).toEqual([1, 2]);
    } finally {
      await view.close();
    }
  });

  it("opens a pattern and selects rows across files; positions run through the files in name order", async () => {
    const view = await View.open(join(dir, "*.csv"), [dir]);
    try {
      expect(view.opened).toMatchObject({ kind: "csv", selectable: true, files: 3 });
      expect(view.opened.card.rows).toBe(9);
      const page = await view.rows(view.opened.fingerprint, 0, 100);
      expect(page.rows.map((r) => r.pos)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8]);
      // The page shows the ids in order, so position n is the row with id n.
      expect(page.rows.map((r) => r.cells[0])).toEqual(["0", "1", "2", "3", "4", "5", "6", "7", "8"]);
      // Rows 2 to 5 cross two file boundaries.
      const ref = await view.ref(view.opened.fingerprint, [[2, 5]]);
      expect(parseRef(ref).where).toContain("filename =");
      expect(ids(await resolveRef(ref, { roots: [dir] }))).toEqual([2, 3, 4, 5]);
      const filtered = await view.rows(view.opened.fingerprint, 0, 100, "id > 6");
      expect(filtered.rows.map((r) => r.pos)).toEqual([7, 8]);
    } finally {
      await view.close();
    }
  });

  it("refuses a pattern whose files have their own file_row_number column", async () => {
    const own = tempDir();
    writeFileSync(join(own, "a.csv"), "id,file_row_number\n1,8\n2,8\n");
    writeFileSync(join(own, "b.csv"), "id,file_row_number\n3,9\n4,9\n");
    await expect(View.open(join(own, "*.csv"), [own])).rejects.toThrow(/file_row_number/);
  });

  it("notices a rewritten text file on the next page, without hashing it again for every page", async () => {
    const path = join(dir, "moving.csv");
    writeFileSync(path, "id,name\n0,aa\n1,bb\n");
    const view = await View.open(path, [dir]);
    try {
      await view.rows(view.opened.fingerprint, 0, 100);
      await view.rows(view.opened.fingerprint, 0, 100);
      // Same size, other bytes, later time.
      await new Promise((r) => setTimeout(r, 20));
      writeFileSync(path, "id,name\n0,aa\n1,bc\n");
      await expect(view.rows(view.opened.fingerprint, 0, 100)).rejects.toThrow(/changed/);
    } finally {
      await view.close();
    }
  });

  it("cuts a range where it crosses from one file into the next", () => {
    const layout = [
      { file: "/d/a.csv", rows: 3 },
      { file: "/d/b.csv", rows: 2 },
    ];
    expect(layoutPredicate([[1, 3]], layout)).toBe(
      "(filename = '/d/a.csv' AND file_row_number BETWEEN 1 AND 2) OR (filename = '/d/b.csv' AND file_row_number = 0)",
    );
    expect(layoutPredicate([[4, 4]], layout)).toBe("(filename = '/d/b.csv' AND file_row_number = 1)");
  });

  it("opens the only table of a DuckDB file, selects by column and refuses a position", async () => {
    const view = await View.open(join(dir, "people.duckdb"), [dir]);
    try {
      expect(view.opened).toMatchObject({ kind: "duckdb", selectable: false, table: "people" });
      const page = await view.rows(view.opened.fingerprint, 0, 100);
      expect(page.rows).toHaveLength(5);
      expect(page.rows.every((r) => r.pos === null)).toBe(true);
      expect(page.next).toBeNull();
      const filtered = await view.rows(view.opened.fingerprint, 0, 100, "id >= 3");
      expect(filtered.matched).toBe(2);
      await expect(view.ref(view.opened.fingerprint, [[0, 1]])).rejects.toThrow(/selected by a column/);
      const ref = await view.ref(view.opened.fingerprint, [], "id = 2", ["name"]);
      expect(parseRef(ref)).toMatchObject({ src: "duckdb", options: { table: "people" }, where: "id = 2" });
      expect(await resolveRef(ref, { roots: [dir] })).toContain('"name":"n2"');
    } finally {
      await view.close();
    }
  });

  it("lists the tables of a DuckDB file, and the one table of a file that has one", async () => {
    await writeDatabase(join(dir, "many2.duckdb"));
    await writeDatabase(join(dir, "one2.duckdb"), { onlyPeople: true });
    expect((await tablesOf(join(dir, "many2.duckdb"), [dir])).sort()).toEqual(["other", "people"]);
    expect(await tablesOf(join(dir, "one2.duckdb"), [dir])).toEqual(["people"]);
    await expect(tablesOf(join(dir, "a.csv"), [dir])).rejects.toThrow(/DuckDB file/);
    await expect(tablesOf(join(tempDir(), "x.duckdb"), [dir])).rejects.toThrow(/outside the allowed roots/);
  });

  it("asks which table when a DuckDB file has several, and opens file#table", async () => {
    await writeDatabase(join(dir, "many.duckdb"));
    await expect(View.open(join(dir, "many.duckdb"), [dir])).rejects.toThrow(/other, people/);
    const view = await View.open(`${join(dir, "many.duckdb")}#people`, [dir]);
    try {
      expect(view.opened.table).toBe("people");
      expect(view.opened.card.rows).toBe(5);
    } finally {
      await view.close();
    }
  });
});
