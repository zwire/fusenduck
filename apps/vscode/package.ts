// Packages the extension as a .vsix for one VS Code target (`--target <t>`, the machine's own by
// default) into apps/vscode/out/. Everything the extension runs is in dist/ (build.ts), so the package
// is dist/ with a package.json that has no dependencies, this folder's README and the repository's
// LICENSE, staged in a folder of their own and handed to vsce.
import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { placedTarget, targetFromArgs } from "./engine.ts";

const here = import.meta.dirname;
const target = targetFromArgs(process.argv);
const out = join(here, "out");
const stage = join(out, `stage-${target}`);

execFileSync(process.execPath, [join(here, "build.ts"), "--target", target], { stdio: "inherit" });
if (placedTarget(join(here, "dist/native")) !== target) throw new Error(`dist/native does not hold the ${target} binding`);

const manifest = JSON.parse(readFileSync(join(here, "package.json"), "utf8")) as Record<string, unknown>;
for (const key of ["private", "scripts", "dependencies", "devDependencies"]) delete manifest[key];
manifest.files = ["dist", "README.md", "LICENSE", "ThirdPartyNotices.txt"];

rmSync(stage, { recursive: true, force: true });
mkdirSync(stage, { recursive: true });
writeFileSync(join(stage, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`);
cpSync(join(here, "dist"), join(stage, "dist"), { recursive: true });
cpSync(join(here, "README.md"), join(stage, "README.md"));
cpSync(join(here, "../../LICENSE"), join(stage, "LICENSE"));
// dist/extension.cjs carries DuckDB's JavaScript and its loader's dependency; their licenses go along.
const requireFromHere = createRequire(join(here, "package.json"));
const requireFromApi = createRequire(requireFromHere.resolve("@duckdb/node-api"));
const requireFromBindings = createRequire(requireFromApi.resolve("@duckdb/node-bindings"));
const notices = [
  ["@duckdb/node-api", requireFromHere],
  ["@duckdb/node-bindings", requireFromApi],
  ["detect-libc", requireFromBindings],
].map(([name, from]) => {
  const folder = dirname((from as NodeJS.Require).resolve(`${name as string}/package.json`));
  return `${name as string}\n\n${readFileSync(join(folder, "LICENSE"), "utf8").trim()}\n`;
});
// dist/extensions carries DuckDB's sqlite_scanner and postgres_scanner (MIT, DuckDB Foundation), which embed SQLite (public domain) and libpq (PostgreSQL License).
notices.push("sqlite_scanner, postgres_scanner (DuckDB extensions, dist/extensions)\n\nMIT License. Copyright 2018-2025 Stichting DuckDB Foundation. They embed SQLite, which is in the public domain, and libpq, under the PostgreSQL License.\n");
writeFileSync(join(stage, "ThirdPartyNotices.txt"), `This extension bundles the following packages.\n\n${notices.join("\n---\n\n")}`);

const vsix = join(out, `fusenduck-${target}-${manifest.version as string}.vsix`);
const vsce = join(dirname(createRequire(import.meta.url).resolve("@vscode/vsce/package.json")), "vsce");
// Relative links in the README point into the repository, where it lives.
const base = "https://github.com/zwire/fusenduck/blob/main/apps/vscode/";
execFileSync(
  process.execPath,
  [vsce, "package", "--target", target, "--no-dependencies", "--baseContentUrl", base, "--baseImagesUrl", base, "--out", vsix],
  { cwd: stage, stdio: "inherit" },
);
rmSync(stage, { recursive: true, force: true });
console.log(`fusenduck: ${vsix}`);
