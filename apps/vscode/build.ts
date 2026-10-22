// Builds the extension into dist/. The extension host runs JavaScript only, so the host side (with
// core and the Web UI's View) is bundled into one CommonJS file; the DuckDB binding stays outside,
// because it is a native module. The webview gets the Web UI's SPA bundled with its message Api,
// and the Web UI's own index.html and style.css.
import { copyFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { build } from "esbuild";

const here = import.meta.dirname;
const dist = join(here, "dist");
const spa = join(here, "../web/spa");
mkdirSync(dist, { recursive: true });

await build({
  entryPoints: [join(here, "src/extension.ts")],
  outfile: join(dist, "extension.cjs"),
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node20",
  external: ["vscode", "@duckdb/node-api"],
  logLevel: "warning",
});
await build({
  entryPoints: [join(here, "webview/main.ts")],
  outfile: join(dist, "webview.js"),
  bundle: true,
  platform: "browser",
  format: "esm",
  target: "es2022",
  logLevel: "warning",
});
for (const file of ["index.html", "style.css"]) copyFileSync(join(spa, file), join(dist, file));
copyFileSync(join(here, "webview/vscode.css"), join(dist, "vscode.css"));
