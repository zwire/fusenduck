// Builds the extension into dist/ for one VS Code target (`--target <t>`, the machine's own by default).
// The extension host runs JavaScript only and cannot resolve pnpm's layout, so the host side (core,
// the Web UI's View and DuckDB's JavaScript) is bundled into one CommonJS file, and DuckDB's native
// binding goes into dist/native (see engine.ts). The webview gets the Web UI's SPA bundled with its
// message Api, and the Web UI's own index.html and style.css.
import { copyFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { build, type Plugin } from "esbuild";
import { placeEngine, targetFromArgs } from "./engine.ts";

const here = import.meta.dirname;
const dist = join(here, "dist");
const spa = join(here, "../web/spa");
mkdirSync(dist, { recursive: true });

// @duckdb/node-bindings requires @duckdb/node-bindings-<platform>/duckdb.node for the platform it
// runs on; every one of those is the binding in dist/native.
const nativeBinding: Plugin = {
  name: "native-binding",
  setup(build) {
    build.onResolve({ filter: /^@duckdb\/node-bindings-[^/]+\/duckdb\.node$/ }, () => ({ path: "./native/duckdb.node", external: true }));
  },
};

await build({
  entryPoints: [join(here, "src/extension.ts")],
  outfile: join(dist, "extension.cjs"),
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node20",
  external: ["vscode"],
  plugins: [nativeBinding],
  logLevel: "warning",
  // DuckDB's loader keeps a computed require for platforms it does not list; it is never reached.
  logOverride: { "unsupported-require-call": "silent" },
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
placeEngine(targetFromArgs(process.argv), join(dist, "native"));
