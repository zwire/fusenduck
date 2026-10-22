import { realpath as realpathCallback } from "node:fs";
import { lstat, readdir } from "node:fs/promises";
import { promisify } from "node:util";
import { join, relative, sep } from "node:path";

// The files the UI offers to open: the Parquet files under each root, found by walking the root's
// folders. Only names and stat are read, never contents. No symlink is followed (a link could lead
// out of the root, or round in a loop), and hidden files and folders are skipped. Opening still goes
// through core's own check of the roots, so this list only saves typing a path.

/** Files listed under one root; past this the list is cut and says so. */
export const MAX_FILES = 5000;
/** Folder entries read under one root, so a huge tree cannot keep the server busy. */
export const MAX_ENTRIES = 100_000;

const PARQUET = /\.parquet$/i;

// The JavaScript realpath, as core uses (realpathSync) to check the roots. The native one can give
// another spelling of the same folder (its case on disk on macOS, a subst drive's target on Windows),
// and core would then refuse to open the listed path.
const realpath = promisify(realpathCallback);

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
  /** truncated: MAX_FILES or MAX_ENTRIES was reached under this root, so some of its files are not listed. */
  roots: { root: string; files: ListedFile[]; truncated: boolean }[];
  /** True when any root was cut. */
  truncated: boolean;
}

export async function listFiles(roots: string[]): Promise<Listed> {
  const seen = new Set<string>();
  const out: Listed["roots"] = [];
  for (const given of roots) {
    const files: ListedFile[] = [];
    let truncated = false;
    out.push({ root: given, files, truncated: false });
    let root: string;
    try {
      root = await realpath(given);
    } catch {
      continue;
    }
    // Each root has its own limits, so a huge root does not hide the files of the next one.
    let entries = 0;
    // Breadth first, so the files near the root are listed before a deep tree uses up the limits.
    const queue = [root];
    while (queue.length && !truncated) {
      const folder = queue.shift()!;
      const found: ListedFile[] = [];
      const folders: string[] = [];
      try {
        // A folder swapped for a symlink would resolve elsewhere. It is checked before and after
        // reading, so what was read while it pointed out of the root is dropped.
        if ((await realpath(folder)) !== folder) continue;
        const dirents = await readdir(folder, { withFileTypes: true });
        dirents.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
        for (const d of dirents) {
          if (++entries > MAX_ENTRIES || files.length + found.length >= MAX_FILES) {
            truncated = true;
            break;
          }
          // Dirent comes from lstat: a symlink is neither a directory nor a file here.
          if (d.name.startsWith(".")) continue;
          const path = join(folder, d.name);
          if (d.isDirectory()) folders.push(path);
          else if (d.isFile() && PARQUET.test(d.name) && !seen.has(path)) {
            const s = await lstat(path).catch(() => undefined);
            if (s?.isFile()) found.push({ path, name: relative(root, path).split(sep).join("/"), size: s.size, modified: s.mtimeMs });
          }
        }
        if ((await realpath(folder)) !== folder) continue;
      } catch {
        continue;
      }
      for (const f of found) seen.add(f.path);
      files.push(...found);
      queue.push(...folders);
    }
    files.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    out.at(-1)!.truncated = truncated;
  }
  return { roots: out, truncated: out.some((r) => r.truncated) };
}
