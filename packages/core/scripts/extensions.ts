// Gets the DuckDB extensions fusenduck ships (build time only; the engine never downloads one).
//
//   node scripts/extensions.ts fetch [--platform <duckdb platform>]...   download, check against extensions.lock.json, unpack
//   node scripts/extensions.ts lock [--update]                           write the pins for every platform from the download
//
// `fetch` fails on any difference from the lock. `lock` is the one place a hash is first written: it records what
// extensions.duckdb.org serves for the DuckDB this repository pins, over HTTPS, and refuses to change an entry that is
// already there unless --update is given. DuckDB also checks the extension's signature when the file is loaded.
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { gunzipSync } from "node:zlib";
import { DuckDBInstance } from "@duckdb/node-api";
import { extensionDirectory, extensionFile, type ExtensionLock } from "../src/extensions.ts";

const lockFile = join(import.meta.dirname, "../extensions.lock.json");

/** The extensions to ship, and the platforms DuckDB publishes them for that fusenduck supports (the VS Code targets, plus Windows on Arm). */
const SHIPPED = ["sqlite_scanner", "postgres_scanner"];
const PLATFORMS = ["linux_amd64", "linux_arm64", "linux_amd64_musl", "linux_arm64_musl", "osx_amd64", "osx_arm64", "windows_amd64", "windows_arm64"];

const sha256 = (data: Uint8Array): string => createHash("sha256").update(data).digest("hex");

async function engine(): Promise<{ version: string; platform: string }> {
  const instance = await DuckDBInstance.create(":memory:");
  const connection = await instance.connect();
  const row = (await connection.runAndReadAll("SELECT version() AS v, platform AS p FROM pragma_platform()")).getRowObjectsJson()[0]!;
  connection.closeSync();
  instance.closeSync();
  return { version: String(row.v), platform: String(row.p) };
}

async function download(url: string): Promise<Buffer> {
  if (!url.startsWith("https://extensions.duckdb.org/")) throw new Error(`refusing to download from ${url}`);
  const response = await fetch(url, { signal: AbortSignal.timeout(120_000) });
  if (!response.ok) throw new Error(`${url}: ${response.status}`);
  return Buffer.from(await response.arrayBuffer());
}

const readLock = (): ExtensionLock => {
  try {
    return JSON.parse(readFileSync(lockFile, "utf8")) as ExtensionLock;
  } catch {
    return {};
  }
};

const args = process.argv.slice(2);
const command = args[0];
const { version, platform: own } = await engine();
const url = (name: string, platform: string) => `https://extensions.duckdb.org/${version}/${platform}/${name}.duckdb_extension.gz`;

if (command === "lock") {
  const update = args.includes("--update");
  const lock = readLock();
  for (const name of SHIPPED) {
    for (const platform of PLATFORMS) {
      const gz = await download(url(name, platform));
      const entry = { url: url(name, platform), gz: sha256(gz), sha256: sha256(gunzipSync(gz)) };
      const old = lock[name]?.[version]?.[platform];
      if (old && (old.gz !== entry.gz || old.sha256 !== entry.sha256) && !update) throw new Error(`${name} ${version} ${platform} differs from the lock: the download is not what was pinned (use --update to accept)`);
      ((lock[name] ??= {})[version] ??= {})[platform] = entry;
      console.log(`${name} ${version} ${platform} ${entry.sha256}`);
    }
  }
  const text = `${JSON.stringify(lock, null, 2)}\n`;
  writeFileSync(`${lockFile}.tmp`, text);
  renameSync(`${lockFile}.tmp`, lockFile);
} else if (command === "fetch") {
  const asked = args.flatMap((a, i) => (a === "--platform" ? [args[i + 1] ?? ""] : []));
  const lock = readLock();
  for (const platform of asked.length ? asked : [own]) {
    for (const name of SHIPPED) {
      const pinned = lock[name]?.[version]?.[platform];
      if (!pinned) throw new Error(`extensions.lock.json has no pin for ${name} ${version} ${platform}`);
      const target = extensionFile(extensionDirectory(), name, version, platform);
      try {
        if (sha256(readFileSync(target)) === pinned.sha256) {
          console.log(`ok ${name} ${version} ${platform} (already here)`);
          continue;
        }
      } catch {
        // Not fetched yet.
      }
      const gz = await download(pinned.url);
      if (sha256(gz) !== pinned.gz) throw new Error(`${pinned.url} does not match the pinned hash`);
      const file = gunzipSync(gz);
      if (sha256(file) !== pinned.sha256) throw new Error(`${name} ${platform} unpacked does not match the pinned hash`);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(`${target}.part`, file);
      renameSync(`${target}.part`, target);
      console.log(`fetched ${name} ${version} ${platform} (${(file.length / 1e6).toFixed(1)} MB)`);
    }
  }
} else {
  console.error("usage: extensions.ts fetch [--platform <p>]... | lock [--update]");
  process.exit(2);
}
