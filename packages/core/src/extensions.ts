import { createHash } from "node:crypto";
import { closeSync, fstatSync, openSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { FusenError } from "./errors.ts";
import lock from "../extensions.lock.json" with { type: "json" };

/**
 * A DuckDB extension is native code, so fusenduck loads only a file it shipped and pinned: the version of DuckDB and the
 * platform choose an entry of extensions.lock.json, and the file is hashed against that entry just before it is loaded.
 * Nothing is downloaded at run time (docs/adr/0004): `pnpm extensions:fetch` does that at build time, against the same lock.
 */
export interface LockedExtension {
  /** Where the build downloads the compressed file from. */
  url: string;
  /** The sha256 of the downloaded .gz. */
  gz: string;
  /** The sha256 of the extension file that is loaded. */
  sha256: string;
}
/** Extension name, then DuckDB version (`v1.5.6`), then DuckDB platform (`linux_amd64`). */
export type ExtensionLock = Record<string, Record<string, Record<string, LockedExtension>>>;

// The pins are part of the code (a bundler carries them along), so a package cannot ship another set beside it.
let directory: string | undefined;

/** Where the shipped extension files are, laid out as `<version>/<platform>/<name>.duckdb_extension`. A package that moves the core code (the VS Code bundle) says where it put them. */
export function setExtensionDirectory(path: string): void {
  directory = path;
}

/** Where the shipped extensions are: set by the package, or beside this source in the repository. */
export const extensionDirectory = (): string => (directory ??= join(import.meta.dirname, "../extensions"));

export const extensionFile = (root: string, name: string, version: string, platform: string): string =>
  join(root, version, platform, `${name}.duckdb_extension`);

const sha256File = (path: string): string => {
  const fd = openSync(path, "r");
  try {
    // Hashed from the open file, so the file that is checked is the one that is read.
    return createHash("sha256").update(readFileSync(fd)).digest("hex");
  } finally {
    closeSync(fd);
  }
};

const verified = new Map<string, string>();

/** The lock entry for an extension on this engine, or undefined when fusenduck ships none for it. */
export function lockedExtension(name: string, version: string, platform: string, pins: ExtensionLock = lock): LockedExtension | undefined {
  const entry = pins[name]?.[version]?.[platform];
  return entry && /^[0-9a-f]{64}$/.test(entry.sha256) ? entry : undefined;
}

/**
 * The path of the shipped extension `name` for this engine, checked against its pin. The wording of a failure is fixed:
 * it names no path, and says how to get the file.
 */
export function bundledExtension(name: string, version: string, platform: string): string {
  const pinned = lockedExtension(name, version, platform);
  if (!pinned) throw new FusenError(`this kind of source needs the ${name} extension, which fusenduck does not ship for DuckDB ${version} on ${platform}`);
  const path = extensionFile(extensionDirectory(), name, version, platform);
  const missing = new FusenError(`the ${name} extension is not in this installation: run "pnpm extensions:fetch" (it is fetched at build time, never at run time)`);
  let size: number;
  try {
    const fd = openSync(path, "r");
    try {
      size = fstatSync(fd).size;
    } finally {
      closeSync(fd);
    }
  } catch {
    throw missing;
  }
  // The pin is checked again whenever the file changed; a file that is the same size and was rewritten is caught by the hash on the first load of the process.
  const key = `${path}:${size}`;
  if (verified.get(key) !== pinned.sha256) {
    if (sha256File(path) !== pinned.sha256) throw new FusenError(`the ${name} extension file does not match the hash fusenduck pins for it, so it is not loaded: run "pnpm extensions:fetch"`);
    verified.set(key, pinned.sha256);
  }
  return path;
}
