import { createElement as h, useEffect, useMemo, useRef, useState, type ReactElement } from "react";
import { Box, Text, useInput, useWindowSize } from "ink";
import { listConnections, listTables } from "@fusenduck/core";
import { listFiles, MAX_FILES, type Listed, type ListedFile } from "@fusenduck/web/files";
import { plain } from "./text.ts";

// The list of data files under the roots, as the Web UI offers them (apps/web/src/files.ts): the
// same walk, so no symlink is followed, hidden files are skipped and the list is cut at the same
// limits. Names come from the disk, so they are made printable before they reach the terminal.

export interface PickerProps {
  roots: string[];
  /** A line to show above the keys, e.g. why the last file did not open. */
  notice: string;
  /** True while a picked file is being opened. */
  opening: boolean;
  open(file: ListedFile): void;
  quit(): void;
}

const CHROME_LINES = 5;
export const PICKER_KEYS = "↑↓ move  enter open  r reload  q quit";
export const TABLE_KEYS = "↑↓ move  enter open  b back to the list  q quit";

export function size(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes;
  let unit = -1;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}

type Line = { root: string } | { file: ListedFile };

/** A connection of connections.toml whose tables are on the screen; tables is null while they are read. */
interface Tables {
  name: string;
  kind: string;
  tables: string[] | null;
  truncated?: boolean;
  error?: string;
}

export function Picker({ roots, notice, opening, open, quit }: PickerProps): ReactElement {
  const { rows: height } = useWindowSize();
  const [listed, setListed] = useState<Listed | null>(null);
  const [cursor, setCursor] = useState(0);
  const [reload, setReload] = useState(0);
  const [connection, setConnection] = useState<Tables | null>(null);
  /** The read of the tables in flight: leaving the screen or choosing again cancels it, and only the newest may answer. */
  const reading = useRef<AbortController | null>(null);
  // connections.toml is read again with `r`, not at every key.
  const connections = useMemo(() => listConnections(), [reload]);
  const leave = () => {
    reading.current?.abort();
    reading.current = null;
    setConnection(null);
    setCursor(0);
  };
  useEffect(() => () => reading.current?.abort(), []);

  useEffect(() => {
    let current = true;
    setListed(null);
    listFiles(roots)
      .then((next) => current && setListed(next))
      .catch(() => current && setListed({ roots: [], truncated: false }));
    return () => {
      current = false;
    };
  }, [roots, reload]);

  const lines: Line[] = [];
  const files: ListedFile[] = [];
  if (connection) {
    // The tables of one connection replace the list of files until `b`.
    for (const t of connection.tables ?? []) {
      const file: ListedFile = { path: `${connection.kind}://${connection.name}/${t}`, name: t, kind: connection.kind, size: 0, modified: 0 };
      lines.push({ file });
      files.push(file);
    }
  } else {
    // Connections come first, as in the Web UI: choosing one lists its tables.
    for (const c of connections) {
      const file: ListedFile = { path: `${c.kind}://${c.name}/`, name: c.name, kind: "connection", size: 0, modified: 0 };
      lines.push({ file });
      files.push(file);
    }
  }
  for (const r of connection ? [] : (listed?.roots ?? [])) {
    lines.push({ root: r.root });
    for (const file of r.files) {
      lines.push({ file });
      files.push(file);
    }
  }
  const at = Math.min(cursor, Math.max(0, files.length - 1));

  useInput((input, key) => {
    if (input === "q" || (key.ctrl && input === "c")) quit();
    else if (opening) return;
    else if (connection && (input === "b" || key.escape || key.leftArrow)) leave();
    else if (key.upArrow || input === "k") setCursor(Math.max(0, at - 1));
    else if (key.downArrow || input === "j") setCursor(Math.min(Math.max(0, files.length - 1), at + 1));
    else if (key.pageUp) setCursor(Math.max(0, at - 10));
    else if (key.pageDown) setCursor(Math.min(Math.max(0, files.length - 1), at + 10));
    else if (input === "r") setReload((n) => n + 1);
    else if (key.return && files[at]?.kind === "connection") {
      const { name, path } = files[at]!;
      const kind = path.slice(0, path.indexOf(":"));
      reading.current?.abort();
      const mine = new AbortController();
      reading.current = mine;
      setConnection({ name, kind, tables: null });
      setCursor(0);
      const answer = (next: Tables) => {
        if (reading.current === mine) setConnection(next);
      };
      listTables(path, mine.signal).then(
        (found) => answer({ name, kind, tables: found.tables, truncated: found.truncated }),
        (error: unknown) => answer({ name, kind, tables: [], error: error instanceof Error ? error.message : String(error) }),
      );
    } else if (key.return && files[at]) open(files[at]);
  });

  // A window of the lines that keeps the cursor's line in view.
  const room = Math.max(3, height - CHROME_LINES);
  const cursorLine = Math.max(0, lines.findIndex((l) => "file" in l && l.file === files[at]));
  const start = Math.max(0, Math.min(cursorLine - Math.floor(room / 2), lines.length - room));
  const shown = lines.slice(start, start + room);

  const count = files.filter((f) => f.kind !== "connection").length;
  const status = connection
    ? connection.error !== undefined
      ? plain(`${connection.name}: ${connection.error}`)
      : connection.tables === null
        ? `${connection.name}: reading the tables…`
        : plain(`${connection.kind} connection ${connection.name}: ${files.length} table${files.length === 1 ? "" : "s"}${connection.truncated ? " (the list is cut; some tables are not listed)" : ""}`)
    : listed === null
      ? "reading…"
      : `${count} file${count === 1 ? "" : "s"}${listed.truncated ? ` (the list is cut at ${MAX_FILES} per root or a limit on folder entries; some files are not listed)` : ""}`;
  return h(
    Box,
    { flexDirection: "column" },
    h(Text, { bold: true, wrap: "truncate-end" }, connection ? "fusen: pick a table" : "fusen: pick a file or a database connection"),
    h(Text, { dimColor: true, wrap: "truncate-end" }, status),
    ...shown.map((line, i) =>
      "root" in line
        ? h(Text, { key: `r${start + i}`, bold: true, wrap: "truncate-end" }, plain(line.root))
        : h(
            Text,
            { key: `f${start + i}`, inverse: line.file === files[at], wrap: "truncate-end" },
            line.file.modified === 0
              ? `  ${plain(line.file.name)}  ${line.file.kind === "connection" ? `${line.file.path.slice(0, line.file.path.indexOf(":"))} connection` : "table"}`
              : `  ${plain(line.file.name)}  ${line.file.kind}  ${size(line.file.size)}  ${new Date(line.file.modified).toISOString().slice(0, 16).replace("T", " ")}`,
          ),
    ),
    !connection && listed !== null && count === 0
      ? h(Text, { wrap: "truncate-end" }, "no Parquet, CSV, JSON, DuckDB or SQLite files under the roots (hidden files and symlinks are skipped). Give a path, or start in another folder.")
      : null,
    h(Text, { wrap: "truncate-end" }, opening ? "opening…" : plain(notice)),
    h(Text, { dimColor: true, wrap: "truncate-end" }, connection ? TABLE_KEYS : PICKER_KEYS),
  );
}
