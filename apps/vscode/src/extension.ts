// The fusenduck extension: Parquet files open by default (CSV, JSON, DuckDB and SQLite files through Open With…)
// in a read-only editor that shows the Web UI (docs/adr/0002)
// in a webview. The webview talks to this extension host by messages (src/host.ts); nothing listens
// on a port.
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import * as vscode from "vscode";
import { messagePage, webviewPage } from "./html.ts";

/** Where the page points for details that it does not show. */
export const SEE_LOG = "The fusenduck log has the kind of error (command: fusenduck: Show Log); set FUSEN_DEBUG=1 for VS Code to log the message too.";

type HostModule = typeof import("./host.ts");

export function activate(context: vscode.ExtensionContext): void {
  const dist = vscode.Uri.joinPath(context.extensionUri, "dist");
  const template = readFileSync(vscode.Uri.joinPath(dist, "index.html").fsPath, "utf8");
  const output = vscode.window.createOutputChannel("fusenduck", { log: true });
  const showLog = () => output.show(true);
  context.subscriptions.push(output, vscode.commands.registerCommand("fusenduck.showLog", showLog));
  // The host's lines come from logLine, which keeps cell values out of the log.
  const log = (line: string) => output.error(line);

  // The host module loads DuckDB's native binding. It loads on the first editor, not on activation,
  // so a binding that cannot load shows in the editor instead of failing the whole extension. A
  // failed load is kept: the bundle does not run a module's top level twice.
  let hostModule: Promise<HostModule> | undefined;
  let loadFailed = false;
  const loadHost = () => (hostModule ??= import("./host.ts"));

  const provider: vscode.CustomReadonlyEditorProvider = {
    openCustomDocument: (uri) => ({ uri, dispose: () => undefined }),
    async resolveCustomEditor(document, panel) {
      const { webview } = panel;
      if (document.uri.scheme !== "file") {
        webview.html = messagePage(
          "fusenduck opens files on this computer's disk only.",
          `This one is a ${document.uri.scheme}: resource. Open the file from the Explorer, or use Reopen Editor With… to view it another way.`,
        );
        return;
      }
      let host: HostModule;
      try {
        host = await loadHost();
        host.setExtensionDirectory(vscode.Uri.joinPath(dist, "extensions").fsPath);
      } catch (error) {
        const platform = `${process.platform}-${process.arch}`;
        webview.html = messagePage(
          "fusenduck could not load its DuckDB engine.",
          `The extension may be a build for another platform than this one (${platform}), or the system may have refused to load its library. Install the build for this platform, then reload the window. ${SEE_LOG}`,
        );
        // Every later editor gets the same failure; it is logged and notified once.
        if (!loadFailed) {
          loadFailed = true;
          // A failed load is about the installation, not the data, so the whole error is logged.
          log(error instanceof Error ? (error.stack ?? error.message) : String(error));
          void vscode.window.showErrorMessage(`fusenduck could not load its DuckDB engine on ${platform}.`, "Show Log").then((choice) => {
            if (choice) showLog();
          });
        }
        return;
      }
      const path = document.uri.fsPath;
      // The engine may read the file's own folder only (docs/adr/0001: roots).
      const editor = new host.Host({
        path,
        roots: [host.rootFor(path)],
        copy: async (text) => {
          await vscode.env.clipboard.writeText(text);
        },
        log,
        withheld: SEE_LOG,
      });
      webview.options = { enableScripts: true, localResourceRoots: [dist] };
      const uri = (file: string) => webview.asWebviewUri(vscode.Uri.joinPath(dist, file)).toString();
      webview.html = webviewPage({
        template,
        cspSource: webview.cspSource,
        nonce: randomBytes(16).toString("base64url"),
        script: uri("webview.js"),
        styles: [uri("style.css"), uri("vscode.css")],
      });
      let disposed = false;
      const listener = webview.onDidReceiveMessage(async (message: unknown) => {
        const reply = await editor.handle(message);
        // The panel may have closed while the host was working.
        if (reply && !disposed) await webview.postMessage(reply).then(undefined, () => undefined);
      });
      panel.onDidDispose(() => {
        disposed = true;
        listener.dispose();
        void editor.close();
      });
    },
  };
  // Parquet opens in it by default. The other kinds are an option of Open With…, so a CSV or JSON file keeps its text editor.
  for (const viewType of ["fusenduck.parquet", "fusenduck.data"]) {
    context.subscriptions.push(
      vscode.window.registerCustomEditorProvider(viewType, provider, {
        webviewOptions: { retainContextWhenHidden: true },
        supportsMultipleEditorsPerDocument: true,
      }),
    );
  }
}

export function deactivate(): void {}
