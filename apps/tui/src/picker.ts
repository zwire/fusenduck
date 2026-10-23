import { createElement as h, useEffect, useState, type ReactElement } from "react";
import { Box, Text, useInput, useWindowSize } from "ink";
import { listFiles, MAX_FILES, type Listed, type ListedFile } from "@fusenduck/web/files";
import { plain } from "./text.ts";

// The list of Parquet files under the roots, as the Web UI offers them (apps/web/src/files.ts): the
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

export function Picker({ roots, notice, opening, open, quit }: PickerProps): ReactElement {
  const { rows: height } = useWindowSize();
  const [listed, setListed] = useState<Listed | null>(null);
  const [cursor, setCursor] = useState(0);
  const [reload, setReload] = useState(0);

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
  for (const r of listed?.roots ?? []) {
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
    else if (key.upArrow || input === "k") setCursor(Math.max(0, at - 1));
    else if (key.downArrow || input === "j") setCursor(Math.min(Math.max(0, files.length - 1), at + 1));
    else if (key.pageUp) setCursor(Math.max(0, at - 10));
    else if (key.pageDown) setCursor(Math.min(Math.max(0, files.length - 1), at + 10));
    else if (input === "r") setReload((n) => n + 1);
    else if (key.return && files[at]) open(files[at]);
  });

  // A window of the lines that keeps the cursor's line in view.
  const room = Math.max(3, height - CHROME_LINES);
  const cursorLine = Math.max(0, lines.findIndex((l) => "file" in l && l.file === files[at]));
  const start = Math.max(0, Math.min(cursorLine - Math.floor(room / 2), lines.length - room));
  const shown = lines.slice(start, start + room);

  const status =
    listed === null
      ? "reading…"
      : `${files.length} Parquet file${files.length === 1 ? "" : "s"}${listed.truncated ? ` (the list is cut at ${MAX_FILES} per root or a limit on folder entries; some files are not listed)` : ""}`;
  return h(
    Box,
    { flexDirection: "column" },
    h(Text, { bold: true, wrap: "truncate-end" }, "fusen: pick a file"),
    h(Text, { dimColor: true, wrap: "truncate-end" }, status),
    ...shown.map((line, i) =>
      "root" in line
        ? h(Text, { key: `r${start + i}`, bold: true, wrap: "truncate-end" }, plain(line.root))
        : h(
            Text,
            { key: `f${start + i}`, inverse: line.file === files[at], wrap: "truncate-end" },
            `  ${plain(line.file.name)}  ${size(line.file.size)}  ${new Date(line.file.modified).toISOString().slice(0, 16).replace("T", " ")}`,
          ),
    ),
    listed !== null && files.length === 0
      ? h(Text, { wrap: "truncate-end" }, "no Parquet files under the roots (hidden files and symlinks are skipped). Give a path, or start in another folder.")
      : null,
    h(Text, { wrap: "truncate-end" }, opening ? "opening…" : plain(notice)),
    h(Text, { dimColor: true, wrap: "truncate-end" }, PICKER_KEYS),
  );
}
