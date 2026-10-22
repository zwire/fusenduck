// The fusenduck extension: Parquet files open in a read-only editor that shows the Web UI (docs/adr/0002)
// in a webview. The webview talks to this extension host by messages (src/host.ts); nothing listens
// on a port.
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import * as vscode from "vscode";
import { Host, rootFor } from "./host.ts";
import { webviewPage } from "./html.ts";

export function activate(context: vscode.ExtensionContext): void {
  const dist = vscode.Uri.joinPath(context.extensionUri, "dist");
  const template = readFileSync(vscode.Uri.joinPath(dist, "index.html").fsPath, "utf8");
  const output = vscode.window.createOutputChannel("fusenduck");
  context.subscriptions.push(output);

  const provider: vscode.CustomReadonlyEditorProvider = {
    openCustomDocument: (uri) => ({ uri, dispose: () => undefined }),
    resolveCustomEditor(document, panel) {
      const { webview } = panel;
      if (document.uri.scheme !== "file") {
        webview.html = "<p>fusenduck opens files on this machine only.</p>";
        return;
      }
      const path = document.uri.fsPath;
      // The engine may read the file's own folder only (docs/adr/0001: roots).
      const host = new Host({
        path,
        roots: [rootFor(path)],
        copy: async (text) => {
          await vscode.env.clipboard.writeText(text);
        },
        log: (error) => output.appendLine(error instanceof Error ? (error.stack ?? error.message) : String(error)),
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
        const reply = await host.handle(message);
        // The panel may have closed while the host was working.
        if (reply && !disposed) await webview.postMessage(reply).then(undefined, () => undefined);
      });
      panel.onDidDispose(() => {
        disposed = true;
        listener.dispose();
        void host.close();
      });
    },
  };
  context.subscriptions.push(
    vscode.window.registerCustomEditorProvider("fusenduck.parquet", provider, {
      webviewOptions: { retainContextWhenHidden: true },
      supportsMultipleEditorsPerDocument: true,
    }),
  );
}

export function deactivate(): void {}
