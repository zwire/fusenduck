# fusenduck for VS Code

Opening a `.parquet` file gives you an editor where you can look at the table, select rows, and copy a **Ref** that returns only the selected rows. A Ref is a single string starting with `fusen://`, and an AI agent can fetch exactly the same rows from it with `fusen resolve` or the MCP server (`fusen_resolve`). The screen is the same as fusenduck's Web UI.

Status: experimental (0.0.0, not published on the Marketplace or Open VSX).

## Usage

1. Open a `.parquet` file from the Explorer (double-clicking opens the fusenduck editor; to use another viewer, right-click and choose "Open With…").
2. The card (row count, column types, null rates, min/max) is on top, and the table, 100 rows at a time, is below. `#` is the position in the file (from 0).
3. Select rows. Click selects one row, Shift+click a range, and Ctrl (⌘)+click adds or removes a row. You can select across pages.
4. Narrow things down if you need to. Unchecking a column in the card removes it from the Ref, and typing a SQL condition (such as `region = 'south' AND amount > 500`) into the Filter rows box and pressing Enter keeps only the rows that match.
5. Press **Copy** and the Ref goes to the clipboard. If you select nothing, it is a Ref for the whole file (or for the rows that match the condition, if there is one).

If the file is rewritten, press **Reload** at the top to read it again. If the file changes after you opened it, no Ref is made and you see "The file changed since it was opened. Open it again." (a Ref that points at different rows from the ones you saw is never made).

## Commands and settings

| Command | What it does |
| --- | --- |
| `fusenduck: Show Log` | Opens the fusenduck log in the Output panel. The error kind (such as `Conversion Error`) and the stack lines appear here |

There are no settings.

## Troubleshooting

- **"Details are withheld because they can contain values from the source."**: The engine's error message can contain cell values, so it is not shown on screen. The log (`fusenduck: Show Log`) contains no cell values, only the error kind and the stack lines. To see the message too, start VS Code with the environment variable `FUSEN_DEBUG=1` (the message can contain cell values).
- **"fusenduck could not load its DuckDB engine."**: The DuckDB bundled in the extension could not be loaded. The usual cause is installing a build for another OS or CPU (other causes: an old glibc, security software blocking the library). The reason is in the log (a load failure is an installation problem, not a data problem, so the full message is written). Install the build for your current environment and reload the window (`Developer: Reload Window`).
- **"fusenduck opens files on this computer's disk only."**: Things that are not files on disk, such as the left side of a Git diff, cannot be opened. Open the file from the Explorer.
- **Filter rows reasons**: A mistyped column name and similar mistakes show their reason as is, and the previous table and condition stay. Table-reading functions (such as `read_csv`), `*` and `COLUMNS(*)` cannot be used.

## Safety

- It is read-only. The engine (DuckDB) can read only the folder of the file you opened, and external access and writing to disk are switched off.
- It opens no port. The screen (webview) talks to the extension only by messages. The webview's CSP allows only scripts with a per-page nonce and styles only from the extension's own files, and blocks all connections.
- Cell values are displayed only as strings. The only thing Copy can put on the clipboard is a Ref.
- It also works when the workspace is not trusted (Restricted Mode), because the extension does not read workspace settings or scripts and only opens files read-only.

## Supported platforms

DuckDB is a native library, so the `.vsix` is split per VS Code platform: `win32-x64`, `win32-arm64`, `darwin-x64`, `darwin-arm64`, `linux-x64`, `linux-arm64`, `alpine-x64` and `alpine-arm64`. VS Code 1.95 or later.

## Development

From the repository root:

```sh
pnpm install
pnpm build                                              # writes the extension, the webview and DuckDB for this OS to apps/vscode/dist
code --extensionDevelopmentPath="$PWD/apps/vscode"      # open VS Code with the extension loaded
pnpm --filter fusenduck package                         # build apps/vscode/out/fusenduck-<target>-<version>.vsix
pnpm --filter fusenduck package --target win32-x64   # for another platform (DuckDB is fetched from the registry and checked against the integrity in pnpm-lock.yaml)
node apps/vscode/smoke.ts apps/vscode/out/fusenduck-linux-x64-0.0.0.vsix  # unpack and load the .vsix and check that a file opens
code --install-extension apps/vscode/out/fusenduck-linux-x64-0.0.0.vsix   # install the .vsix you built
```

After running `package` for another platform, `dist/native` holds that platform's DuckDB, so run `pnpm build` again when you return to development.

| File | Contents |
| --- | --- |
| `src/extension.ts` | The read-only custom editor (`*.parquet`) and `fusenduck: Show Log`. DuckDB is loaded in the first editor, and if it cannot be loaded, that editor shows the reason |
| `src/host.ts` | Answers the webview's messages (`init`, `open`, `rows`, `ref`, `copy`). Uses `apps/web`'s `View`, and can open only that editor's file |
| `src/html.ts` | Puts the webview CSP and nonce into the Web UI's `index.html`. Also the page for the message shown when a file cannot be opened |
| `webview/main.ts` | Starts the Web UI's SPA with an `Api` that works through messages to the host |
| `webview/vscode.css` | VS Code's theme colors and fonts |
| `build.ts` | Uses esbuild to bundle the host side (core, the Web UI's `View`, DuckDB's JavaScript) into one `dist/extension.cjs`, and builds `dist/webview.js`. DuckDB's native part goes in `dist/native` |
| `engine.ts` | The mapping between VS Code platforms and DuckDB binaries. Places the binary in `dist/native` |
| `package.ts` | Lays out only `dist`, the README, the LICENSE and the licenses of the bundled JavaScript (`ThirdPartyNotices.txt`) in a separate folder, and builds the `.vsix` with vsce |
| `smoke.ts` | Loads and runs the `.vsix` against a small stand-in `vscode` module. The load happens in a separate process that has not read DuckDB yet (so a reused, already-loaded libduckdb does not hide a missing file) |

The design is in [ADR 0002](../../docs/adr/0002-web-ui-transport.md), and the details of how Refs and conditions are handled are in [docs/guide.md](../../docs/guide.md).
