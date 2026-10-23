# @fusenduck/web

The Web UI `fusen-web`. A local server that listens on loopback serves the SPA and a small JSON API from the same origin. The design is in [ADR 0002](../../docs/adr/0002-web-ui-transport.md), and usage is in chapter 9 of [docs/guide.md](../../docs/guide.md).

```sh
pnpm build   # compile the SPA (spa/*.ts) into dist/ with tsc
node apps/web/src/index.ts [--root <dir>]... [--host <loopback>] [--port <n>] [--no-open]
# → fusen-web: opening http://127.0.0.1:<port>/#c=<code> in your browser (the link works once, within 60 seconds)
```

## Layout

| File | Contents |
| --- | --- |
| `src/index.ts` | Entry point (argument parsing, printing the URL and launching the browser, closing the engine at exit) |
| `src/browser.ts` | Opens a URL in the default browser (`open` / `rundll32` / `xdg-open`, never through a shell; does nothing without a display) |
| `src/server.ts` | HTTP: the redeem code and token, checks for Host, Origin, JSON and Bearer, headers such as CSP, static files |
| `src/files.ts` | The list of Parquet files under the roots (symlinks are not followed, hidden files are skipped, the count is capped) |
| `src/view.ts` | One opened file: the engine (one per source, one operation at a time), pages of rows (with a condition too), and a Ref from position ranges, a condition and columns |
| `spa/api.ts` | What the SPA calls into core. Swap the `Api` and the SPA can be used from something other than the local server (such as a VS Code webview) |
| `spa/app.ts` | The file list and filter, the table, column checkboxes, the row condition, selection and Copy. Values enter the DOM only through `textContent` |

## API (internal, unversioned)

All requests are `POST` with a JSON body, and everything except `/api/session` needs `Authorization: Bearer <token>`.

| Path | Body | Returns |
| --- | --- | --- |
| `/api/session` | `{ code }` | `{ token }`. The code works once, for up to 60 seconds |
| `/api/files` | `{}` | `{ roots: [{ root, files: [{ path, name, size, modified }], truncated }], truncated }`. `name` is the `/`-separated path from the root, and `path` is the path to pass when opening |
| `/api/open` | `{ path }` | `{ source, fingerprint, card, ref, selectable }` |
| `/api/rows` | `{ source, fingerprint, offset, limit?, where? }` | `{ rows: [{ pos, cells }], next, cut, matched }`. `limit` is 1 to 500 (default 100). With `where`, only the matching rows are returned; `offset` and `next` are positions (in a file that cannot be selected by position, the order among the matching rows), and `matched` is the number of matching rows |
| `/api/ref` | `{ source, fingerprint, ranges: [[a, b], ...], where?, columns? }` | `{ ref }`. Ranges are merged, up to 1,000. With both ranges and `where`, the rows matching both; with no ranges, the rows of `where`. `where` cannot use table-reading functions, `*` or `COLUMNS(*)`. `columns` is reordered into the file's column order, and `cols=` is omitted when all columns are kept |

If the file has changed since it was opened, the response is `409` with `{ error, changed: true }`. Error messages are only ones built by core; the engine's own error messages are withheld.
