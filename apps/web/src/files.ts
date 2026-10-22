import { lstat, readdir, realpath } from "node:fs/promises";
import { join, relative, sep } from "node:path";

// The files the UI offers to open: the Parquet files under each root, found by walking the root's
// folders. Only names and stat are read, never contents. No symlink is followed (a link could lead
// out of the root, or round in a loop), and hidden files and folders are skipped. Opening still goes
// through core's own check of the roots, so this list only saves typing a path.

/** Files listed across all roots; past this the list is cut and says so. */
export const MAX_FILES = 5000;
/** Folder entries read across all roots, so a huge tree cannot keep the server busy. */
export const MAX_ENTRIES = 100_000;

const PARQUET = /\.parquet$/i;

export interface ListedFile {
  /** The path to open. */
  path: string;
  /** The path from the root, with / between folders. */
  name: string;
  size: number;
  /** Last modified, in milliseconds since the epoch. */
  modified: number;
}

export interface Listed {
  roots: { root: string; files: ListedFile[] }[];
  /** True when MAX_FILES or MAX_ENTRIES was reached, so some files are not listed. */
  truncated: boolean;
}

export async function listFiles(roots: string[]): Promise<Listed> {
  const seen = new Set<string>();
  let entries = 0;
  let truncated = false;
  const out: Listed["roots"] = [];
  for (const given of roots) {
    const files: ListedFile[] = [];
    out.push({ root: given, files });
    let root: string;
    try {
      root = await realpath(given);
    } catch {
      continue;
    }
    // Breadth first, so the files near the root are listed before a deep tree uses up the limits.
    const queue = [root];
    while (queue.length && !truncated) {
      const folder = queue.shift()!;
      let dirents;
      try {
        // A folder swapped for a symlink since its parent was read would resolve elsewhere.
        if ((await realpath(folder)) !== folder) continue;
        dirents = await readdir(folder, { withFileTypes: true });
      } catch {
        continue;
      }
      dirents.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
      for (const d of dirents) {
        if (++entries > MAX_ENTRIES || seen.size >= MAX_FILES) {
          truncated = true;
          break;
        }
        // Dirent comes from lstat: a symlink is neither a directory nor a file here.
        if (d.name.startsWith(".")) continue;
        const path = join(folder, d.name);
        if (d.isDirectory()) queue.push(path);
        else if (d.isFile() && PARQUET.test(d.name) && !seen.has(path)) {
          seen.add(path);
          try {
            const s = await lstat(path);
            if (s.isFile()) files.push({ path, name: relative(root, path).split(sep).join("/"), size: s.size, modified: s.mtimeMs });
          } catch {
            seen.delete(path);
          }
        }
      }
    }
    files.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  }
  return { roots: out, truncated };
}
