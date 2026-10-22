// Loads a packaged .vsix the way VS Code would, without VS Code: unpacks it, loads dist/extension.cjs
// with a stand-in `vscode` module, activates it, opens a Parquet file in its editor and sends the
// webview's messages. It proves the package carries a DuckDB binding that loads on this machine, and
// that the editor answers from inside the package's own layout.
//
//   node smoke.ts out/fusenduck-<target>-<version>.vsix
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import Module from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { DuckDBInstance } from "@duckdb/node-api";
import { TAR } from "./engine.ts";

const vsix = resolve(process.argv[2] ?? "");
const temp = mkdtempSync(join(tmpdir(), "fusenduck-smoke-"));

function check(ok: unknown, what: string): void {
  if (!ok) throw new Error(`smoke: ${what}`);
  console.log(`ok - ${what}`);
}

/** Unpacks the .vsix (a zip) into a new folder and returns its extension/ folder. */
function unpack(name: string): string {
  const into = join(temp, name);
  mkdirSync(into);
  // GNU tar (Linux) does not read zip.
  if (process.platform === "linux") execFileSync("unzip", ["-q", vsix, "-d", into]);
  else execFileSync(TAR, ["-xf", vsix, "-C", into]);
  return join(into, "extension");
}

interface Panel {
  html: string;
  replies: unknown[];
  send(message: unknown): Promise<void>;
  dispose(): void;
}

/** Activates the extension in `root` with a stand-in vscode module, and opens editors on files. */
function load(root: string): { open(path: string): Promise<Panel>; errors: string[]; copied: string[] } {
  const errors: string[] = [];
  const copied: string[] = [];
  const uri = (path: string) => ({ scheme: "file", fsPath: path, toString: () => pathToFileURL(path).href });
  let provider: { resolveCustomEditor(document: unknown, panel: unknown): Promise<void> } | undefined;
  const vscode = {
    Uri: { joinPath: (base: { fsPath: string }, ...parts: string[]) => uri(join(base.fsPath, ...parts)) },
    window: {
      createOutputChannel: () => ({ error: (line: string) => void errors.push(line), show: () => undefined, dispose: () => undefined }),
      registerCustomEditorProvider: (_type: string, p: typeof provider) => ((provider = p), { dispose: () => undefined }),
      showErrorMessage: (message: string) => (errors.push(message), Promise.resolve(undefined)),
    },
    commands: { registerCommand: () => ({ dispose: () => undefined }) },
    env: { clipboard: { writeText: async (text: string) => void copied.push(text) } },
  };
  const original = (Module as unknown as { _load: (...args: unknown[]) => unknown })._load;
  (Module as unknown as { _load: (...args: unknown[]) => unknown })._load = function (request: unknown, ...rest: unknown[]) {
    return request === "vscode" ? vscode : original.call(this, request, ...rest);
  };
  const extension = createRequire(join(root, "package.json"))("./dist/extension.cjs") as { activate(context: unknown): void };
  extension.activate({ extensionUri: uri(root), subscriptions: [] });
  return {
    errors,
    copied,
    async open(path) {
      let listener: ((message: unknown) => Promise<void>) | undefined;
      let onDispose: (() => void) | undefined;
      const replies: unknown[] = [];
      const webview = {
        html: "",
        options: {},
        cspSource: "https://webview.test",
        asWebviewUri: (u: { toString(): string }) => u,
        onDidReceiveMessage: (fn: typeof listener) => ((listener = fn), { dispose: () => undefined }),
        postMessage: async (message: unknown) => (replies.push(message), true),
      };
      await provider!.resolveCustomEditor({ uri: uri(path) }, { webview, onDidDispose: (fn: () => void) => void (onDispose = fn) });
      return {
        get html() {
          return webview.html;
        },
        replies,
        send: async (message) => listener!(message),
        dispose: () => onDispose?.(),
      };
    },
  };
}

try {
  const file = join(temp, "smoke.parquet");
  const connection = await (await DuckDBInstance.create(":memory:")).connect();
  await connection.run(`COPY (SELECT i AS id, 'row ' || i AS label FROM range(0, 500) t(i)) TO '${file.replaceAll("'", "''")}' (FORMAT parquet)`);
  connection.closeSync();

  const manifest = JSON.parse(readFileSync(join(unpack("good"), "package.json"), "utf8")) as { main: string };
  check(manifest.main === "./dist/extension.cjs", "the package's main is the bundled extension");

  const good = load(join(temp, "good/extension"));
  const panel = await good.open(file);
  check(panel.html.includes('data-host="vscode"') && panel.html.includes("Content-Security-Policy"), "the editor shows the webview page with its CSP");
  await panel.send({ id: 1, method: "open", params: { path: file } });
  const opened = (panel.replies.at(-1) as { result: { source: string; fingerprint: string } }).result;
  check(opened?.fingerprint, "the packaged DuckDB binding loads and opens the file");
  await panel.send({ id: 2, method: "rows", params: { source: opened.source, fingerprint: opened.fingerprint, offset: 10, limit: 3 } });
  const rows = (panel.replies.at(-1) as { result: { rows: { pos: number }[] } }).result.rows;
  check(rows.map((r) => r.pos).join() === "10,11,12", "rows come back by position");
  await panel.send({ id: 3, method: "ref", params: { source: opened.source, fingerprint: opened.fingerprint, ranges: [[10, 12]] } });
  const ref = (panel.replies.at(-1) as { result: string }).result;
  await panel.send({ id: 4, method: "copy", params: { text: ref } });
  check(good.copied.at(-1) === ref && ref.startsWith("fusen://"), "a Ref for the selection reaches the clipboard");
  panel.dispose();
  check(good.errors.length === 0, "nothing was logged");

  // The same package without its binding: the extension still activates, and the editor says why it
  // cannot open the file instead of failing.
  const broken = join(temp, "broken/extension");
  unpack("broken");
  renameSync(join(broken, "dist/native/duckdb.node"), join(broken, "dist/native/moved.node"));
  const bad = load(broken);
  const message = (await bad.open(file)).html;
  check(message.includes("could not load its DuckDB engine"), "a binding that cannot load is shown in the editor");
  check(bad.errors.some((line) => line.includes("duckdb.node")), "and its error goes to the log");
} finally {
  rmSync(temp, { recursive: true, force: true });
}
