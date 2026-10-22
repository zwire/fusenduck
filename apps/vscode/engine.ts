// The DuckDB binding the extension ships. @duckdb/node-bindings loads a native module from a package
// per platform (@duckdb/node-bindings-<platform>/duckdb.node, with libduckdb beside it). The extension
// host cannot resolve packages the way pnpm lays them out, and a .vsix is built for one VS Code target,
// so build.ts points every such require at dist/native/duckdb.node and this module puts that target's
// files there: from node_modules when pnpm installed them (the machine's own platform), otherwise from
// the registry, checked against the integrity pnpm-lock.yaml records.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

/** VS Code's platform targets (vsce --target) that DuckDB ships a binding for, and that binding's suffix. */
export const TARGETS = {
  "linux-x64": "linux-x64",
  "linux-arm64": "linux-arm64",
  "alpine-x64": "linux-x64-musl",
  "alpine-arm64": "linux-arm64-musl",
  "darwin-x64": "darwin-x64",
  "darwin-arm64": "darwin-arm64",
  "win32-x64": "win32-x64",
  "win32-arm64": "win32-arm64",
} as const;
export type Target = keyof typeof TARGETS;

export function isTarget(value: string): value is Target {
  return Object.hasOwn(TARGETS, value);
}

/** The target of the machine running this script. */
export function nativeTarget(): Target {
  const header = process.report.getReport() as { header?: { glibcVersionRuntime?: string } };
  const musl = process.platform === "linux" && !header.header?.glibcVersionRuntime;
  const target = `${musl ? "alpine" : process.platform}-${process.arch}`;
  if (!isTarget(target)) throw new Error(`DuckDB ships no binding for ${target}`);
  return target;
}

/** `--target <t>` from argv, or the machine's own target. */
export function targetFromArgs(argv: string[]): Target {
  const at = argv.indexOf("--target");
  if (at < 0) return nativeTarget();
  const value = argv[at + 1] ?? "";
  if (!isTarget(value)) throw new Error(`--target must be one of ${Object.keys(TARGETS).join(", ")}`);
  return value;
}

/** bsdtar, which reads zip as well as tar.gz. On Windows, Git's GNU tar can come first on PATH. */
export const TAR = process.platform === "win32" ? join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe") : "tar";

const here = import.meta.dirname;
const lockfile = join(here, "../../pnpm-lock.yaml");
// Resolved from @duckdb/node-api, as the extension's own code does.
const requireFromApi = createRequire(createRequire(join(here, "package.json")).resolve("@duckdb/node-api"));
const bindings = dirname(requireFromApi.resolve("@duckdb/node-bindings/package.json"));
const requireFromBindings = createRequire(join(bindings, "package.json"));

/** The installed @duckdb/node-bindings version, which every platform package matches. */
export const BINDINGS_VERSION = (JSON.parse(readFileSync(join(bindings, "package.json"), "utf8")) as { version: string }).version;

/** The folder of the binding package for `target`: installed, or fetched into a temporary folder. */
function bindingFolder(target: Target): { folder: string; cleanup(): void } {
  const name = `@duckdb/node-bindings-${TARGETS[target]}`;
  try {
    return { folder: dirname(requireFromBindings.resolve(`${name}/package.json`)), cleanup: () => undefined };
  } catch {
    // Not installed: pnpm installs the optional binding for this machine's platform only.
  }
  const spec = `${name}@${BINDINGS_VERSION}`;
  const escaped = spec.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
  const integrity = new RegExp(`'${escaped}':\\n\\s+resolution: \\{integrity: (sha512-[A-Za-z0-9+/=]+)\\}`).exec(readFileSync(lockfile, "utf8"))?.[1];
  if (!integrity) throw new Error(`pnpm-lock.yaml has no integrity for ${spec}`);
  const temp = mkdtempSync(join(tmpdir(), "fusenduck-binding-"));
  const cleanup = () => rmSync(temp, { recursive: true, force: true });
  try {
    const out = execFileSync("npm", ["pack", spec, "--silent", "--pack-destination", temp], { encoding: "utf8", shell: process.platform === "win32" });
    const tarball = join(temp, out.trim().split(/\r?\n/).pop()!);
    const actual = `sha512-${createHash("sha512").update(readFileSync(tarball)).digest("base64")}`;
    if (actual !== integrity) throw new Error(`${spec} does not match pnpm-lock.yaml (${actual})`);
    execFileSync(TAR, ["-xzf", tarball, "-C", temp]);
    return { folder: join(temp, "package"), cleanup };
  } catch (error) {
    cleanup();
    throw error;
  }
}

/** Puts the binding for `target` into `native` (dist/native), replacing what was there. */
export function placeEngine(target: Target, native: string): void {
  const { folder, cleanup } = bindingFolder(target);
  try {
    const files = readdirSync(folder).filter((file) => file === "duckdb.node" || /^(lib)?duckdb\.(so|dylib|dll)$/.test(file));
    if (!files.includes("duckdb.node")) throw new Error(`no duckdb.node in ${folder}`);
    rmSync(native, { recursive: true, force: true });
    mkdirSync(native, { recursive: true });
    for (const file of [...files, "LICENSE"]) copyFileSync(join(folder, file), join(native, file));
    // placedTarget reads it back, so a .vsix never ships another target's binding.
    copyFileSync(join(folder, "package.json"), join(native, "package.json"));
    const size = files.reduce((sum, file) => sum + statSync(join(native, file)).size, 0);
    console.log(`fusenduck: DuckDB ${BINDINGS_VERSION} for ${target} (${(size / 1e6).toFixed(0)} MB) in ${native}`);
  } finally {
    cleanup();
  }
}

/** The target whose binding is in `native`, from the binding's own package.json. */
export function placedTarget(native: string): Target | undefined {
  const { name } = JSON.parse(readFileSync(join(native, "package.json"), "utf8")) as { name: string };
  return (Object.keys(TARGETS) as Target[]).find((target) => name === `@duckdb/node-bindings-${TARGETS[target]}`);
}
