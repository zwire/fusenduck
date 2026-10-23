# ADR 0002: The Web UI and the route from the browser to Core

- Status: Accepted (2026-10-22, takumi approved option B)
- Date: 2026-10-22
- Verdict: go (build the first slice as an increment)

## Background

The vision document (`docs/vision.md`, chapter 5) says the Web UI is an SPA (`apps/web`) that will later be reused in a VS Code extension's webview. The GUI's job is "select, then copy a Ref with one click" (5.1).
What was undecided was how the browser reaches Core. Core reads local files, so it must not be usable from some other page open in the browser. The existing `fusen-mcp --http` is loopback-only and requires a Bearer token (PR #10).

The spike [web-ui](evidence/web-ui.md) tried three routes from a real Chromium (Playwright, headless). The spike code is in `.scratch/web-ui` and is not included in the repository.

| Route | Result |
| --- | --- |
| A. The SPA calls `fusen-mcp --http` directly | It cannot be called even from the legitimate SPA. Because of the Authorization header a CORS preflight (OPTIONS) is sent, and the server answers 401 without CORS headers |
| B. A local server that serves the SPA and a small JSON API from the same origin | It works. A page from another origin (even one that stole the token), a no-cors simple POST, DNS rebinding and a path outside the root were all refused (a page embedded in an iframe could not read the contents, but we did not confirm that it was `frame-ancestors` that stopped it) |
| C. Run only inside the browser with DuckDB-WASM | The page cannot learn a file's absolute path (`C:\fakepath\orders.parquet`). A Ref is `fusen://file/<absolute path>`, so an agent cannot resolve a Ref minted in the browser |

With B, in all four cases (clicking a row, a Shift range, a Ctrl addition, and a row on page 2), `resolveRef` on the copied Ref matched the selected ids exactly. On a 1,000,000-row (10.8 MB) Parquet file, opening (card) took about 0.2 seconds, a 100-row page about 0.06 seconds, and minting a Ref about 0.025 seconds.

## Decision

### 1. Route: a local server that serves the SPA

- `apps/web` holds the SPA and the server that serves it. It starts with `fusen-web --root <dir>` (like `fusen-mcp`, it opens only files under the roots).
- The server binds to loopback addresses only. By default the OS picks the port (`0`), and the URL is printed after binding is done. A 32-byte random session token is generated at each start.
- The URL carries not the session token but a **redeem code that can be used once** (`http://127.0.0.1:<port>/#c=<code>`). When the browser is opened automatically, the URL becomes a process argument and is visible to other users on the same machine (`/proc/*/cmdline` on Linux). The SPA exchanges this code for the session token with a POST, and the code expires at the first exchange or after 60 seconds.
- The code is passed in the URL **fragment**. A fragment is not sent with the request, so it does not appear in server logs, proxies or the Referer. It can remain in browser history, but the code is unusable after the exchange. The SPA keeps the session token in sessionStorage and removes the fragment from the address bar.
- Every API call has the server check the following. The Host is the server itself (against DNS rebinding), the Origin, if present, is the server itself, the Content-Type is `application/json` (so that simple requests become subject to a preflight), and the Bearer token (constant-time comparison). No CORS headers are sent.
- Responses carry this CSP: `default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'; require-trusted-types-for 'script'` (the last item makes the browser refuse assigning strings to `innerHTML` and the like). `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer` and `Cache-Control: no-store` are also set.
- Static files (the SPA) are served without a token, because the SPA itself contains no data.
- `fusen-mcp --http` does not change. We do not add CORS to the agents' entry point and widen it for the UI.

### 2. Data shown in the browser

- Cell values and the card's min/max are both treated as untrusted input. They enter the DOM only through `textContent`, never `innerHTML` (in the spike, cells containing `<img onerror>` and `</script>` were displayed as strings and nothing ran).
- Errors return to the page only as the fixed wording that went through core's `describeError` (an engine error message can quote cell values; ADR 0001).

### 3. From selection to Ref

- Table rows are shown with their `file_row_number`, and a selection becomes a predicate that merges position ranges (`file_row_number BETWEEN 10 AND 14 OR file_row_number = 40`). No key column is needed. One selection can be merged into at most 1,000 ranges.
- When a file has a real column named `file_row_number`, the predicate reads that column and rows cannot be selected by position (ADR 0001). For that file `open` says so, and selection is disabled.
- A Ref is minted on the server each time the selection changes. Only the result of the latest selection is reflected, and Copy waits for a Ref that is still being minted before copying (in the spike, without waiting the previous Ref was copied; disabling the button caused fast clicks to be ignored).
- **Make the Ref match what was seen.** The page holds the fingerprint from when it was opened and sends it when a Ref is minted. If the file's fingerprint differs, minting is refused and the page shows "the file changed, read it again". In the spike, after viewing id 7 and then rewriting the file, the copied Ref returned id 8. For this reason an "expected fingerprint" argument is added to core's `mintRef`. The Ref grammar does not change. The limit of the fingerprint (a rewrite that leaves every column statistic the same cannot be detected; ADR 0001) remains here too.

### 4. The API and the SPA's construction

- One engine is created per opened Source (ADR 0001: one instance = a fixed Source), and it is closed when a different file is opened and when the server exits.
- The vision document, chapter 5, says "Core speaks one protocol (HTTP/JSON-RPC)", but this API is a separate, UI-only entry point. The agents' contract remains the MCP tools; this is a deliberate deviation so that MCP is not widened for the UI.
- The API is an internal same-origin API and not a contract (stability: internal. It carries no version and may change without notice). At first there are three calls: `open` (the card and a whole-file Ref), `rows` (a page in position order) and `ref` (a Ref from position ranges).
- The SPA is just TypeScript compiled to ES modules with `tsc`, with no framework and no bundler (the spike's SPA fit in 4.2 KB). No dependencies are added. So that it can be reused in a VS Code webview, only the target the API calls go to can be swapped.

## Consequences

- Good: Core's protections (ADR 0001's engine lock, the root restriction) are used as they are. It cannot be used from other pages open in the browser. A Ref can be resolved by agents with the CLI or MCP.
- Bad: using the UI requires starting one process. The token changes at every start, so after closing the browser you need to reopen the URL.
- Other processes on the same machine can reach loopback. The session token is the protection that assumes this, and sharing a later URL does not open it because a redeem code was used. But processes running with the same user's privileges (browser extensions included) are outside the protection, and the docs say so.

## Rejected options

- A (call MCP's HTTP directly): it cannot be called as things stand, and making it callable would require adding CORS to the agents' entry point and having users paste the token into the page.
- C (DuckDB-WASM): the page cannot learn the file's path, so it cannot make a Ref an agent can resolve. It would also run a second engine outside ADR 0001's engine lock.
- Holding the token in a cookie: the browser sends it automatically, so it is attached even to requests from another page (CSRF). Sending it in a header is simpler to protect.
- Passing the token in the query string: it goes with the request, so it would remain in server and proxy logs and in the Referer.
- Putting the session token itself in the URL: it would be readable by other users as the browser's launch argument.

## First slice

"Start `fusen-web`, open a Parquet file in the browser, look at the card and rows, select rows or a range, and when you copy the Ref, it returns only the selected rows."

Acceptance tests (evidence is the actual output):
1. In Chromium (Playwright), running `fusen resolve` on the Ref copied after selecting one row, a Shift range, a Ctrl addition and a row on page 2 returns only the selected rows.
2. Selecting rows after the file has been rewritten makes no Ref and shows "the file changed".
3. API protection (integration tests): the redeem code is refused the second time and after 60 seconds, no token gives 401, a different Origin 403, a different Host 403, non-JSON 415, a path outside the root is refused with fixed wording. A non-loopback `--host` is refused at startup.
4. Cells and the card containing `<img onerror>` and `</script>` are displayed as plain strings and nothing runs.
5. The response's CSP matches the string above exactly, and `nosniff`, `no-referrer` and `no-store` are set. Embedding in a cross-origin iframe is refused as a CSP violation (the console violation is the evidence).
6. Clicking a row and immediately pressing Copy copies the Ref of the latest selection (the race found in the spike).
7. For a file with a column named `file_row_number`, selection is disabled and the page says so.

Budgets (initial values; to be revisited with measurements):
- On a 1,000,000-row Parquet file: open (card) within 1 second, a 100-row page within 0.2 seconds, minting a Ref within 0.1 seconds (the spike measured about 0.2 / 0.06 / 0.025 seconds).
- Rows per page: default 100, maximum 500. One selection is at most 1,000 ranges.
- The SPA within 50 KB with no runtime dependencies (the spike was 4.2 KB).

## About the spike code

The spike code stays in `.scratch/web-ui` and is not brought in. `apps/web` is written fresh, in the real layout, from what the spike taught. The spike's shortcuts (opening a new engine on every request and never closing it, building SQL as strings, no upper limit on the number of ranges, returning engine error messages as they are, no fingerprint check, no types or tests) are not carried over.

## Open questions (outside the slice)

- What the API calls go to in a VS Code extension's webview (messages to the extension host, or the same local server).
  - 2026-10-22 addendum: it became messages to the extension host (`apps/vscode`). That avoids holding a port and a token, and lets the webview's CSP block all connections. The host uses `apps/web`'s `View` as it is, and the webview reuses the Web UI's `index.html` and SPA.
- How to open a file (typing a path only, or showing a list under the roots). The first slice was path input only. Later a list under the roots (`/api/files`, symlinks not followed) was added, and path input was kept.
- Column selection (`cols=`), entering a predicate, and making a Ref with a query from the UI.
