# ADR 0003: Build the TUI with ink

- Status: Accepted (2026-10-23, takumi approved option B)
- Date: 2026-10-23
- Verdict: go (build the first slice as an increment)

## Background

The vision document (`docs/vision.md`) lists a TUI alongside the Web UI and the VS Code extension. Its job is the same as the other UIs: select, then copy a Ref.
There were two things to decide: how to build the screen (Node's standard library only, or a library), and how to carry over the existing protections.

## Decision

### 1. The screen is built with ink (React rendering for the terminal)

takumi chose B from three options.

| Option | What it is | Verdict |
| --- | --- | --- |
| A | Draw with only Node's standard library (`readline`, raw mode, ANSI) | Rejected (it was the recommendation, but takumi chose B) |
| B | Bring in ink | **Adopted** |
| C | A minimal interaction with only a list and typing a row number | Rejected |

### 2. Adding dependencies, and the relation to ADR 0002

ADR 0002's "add no dependencies" is a decision about the SPA (the 4.2 KB served to the browser) and does not bind the policy on runtime dependencies. Still, today's runtime dependencies are only DuckDB and the MCP SDK (and zod), and the TUI increases them considerably. The effects are as follows.

- **How much is added**: ink 8.0.0 and react 19.3.1 as `apps/tui` runtime dependencies. Transitively 33 packages are added (an increase of 37 entries in the lockfile, 2 of which are the type-only `@types/react` and `csstype`). Of what we checked (ink, react, react-reconciler, yoga-layout, chalk, es-toolkit), all are MIT licensed.
- **Install-time scripts**: none of the additions has `requiresBuild` (checked in `pnpm-lock.yaml`). The `pnpm.neverBuiltDependencies` policy does not change. No native binaries are added either (`yoga-layout` is WebAssembly, 332 KB).
- **Pinning**: `ink`, `react` and `@types/react` are pinned to exact versions, not ranges. Updates are raised by hand after looking at the lockfile diff.
- **Reach**: the dependencies live only in `apps/tui` (private). The dependencies of `packages/core`, `packages/cli`, `packages/mcp`, `apps/web` and the VS Code extension do not change. ink does not go into the `.vsix` or `fusen-web`.
- **Backing out**: the screen is the single file `apps/tui/src/app.ts`, and only that and `mount.ts` depend on ink. Selection (`selection.ts`) and terminal sanitization (`text.ts`) do not use ink. To go back to A, only the rendering needs rewriting.

### 3. Existing protections are carried over by using `apps/web`'s `View`

The TUI uses the same `View` as the Web UI and the VS Code extension, and does not call `core` directly. So the following apply as they are.

- Only files under the roots can be opened (`--root`, default: the current directory).
- Every query has a clock (`DEFAULT_TIMEOUT_MS`).
- The card's min/max appears with PII masked (core's `buildCard`).
- If the file has changed since it was opened, no Ref is made and "the file changed" is shown (`SourceChanged`).
- Errors show only the fixed wording of `describeError`, and unexpected errors go to stderr through `logLine`.

The TUI adds two protections of its own.

- **Abort on disconnect**: the screen creates an `AbortController` per operation, and stops a running query on a new operation, on exit (`q`, Ctrl-C), and when the terminal closes (`SIGHUP`, `SIGTERM`). `View` passes the signal to the engine (PR #29).
- **Sanitize what is written to the terminal**: strings of cells, column names, paths and conditions are file contents and are not trusted. A terminal reacts to control characters (cursor movement, clearing the screen, the window title, rewriting the clipboard with OSC 52), so C0/C1 control characters, DEL, bidirectional control characters, zero-width and invisible format characters, and tag characters are replaced with `�`, and newlines with `⏎` (`text.ts`). ink 8 also strips escapes inside strings (we confirmed with `renderToString` that OSC and CSI disappear), but we do not leave the protection to a dependency's behavior. Stripping silently removes content, so we replace them with visible markers here.

### 4. Screen and controls

`fusen-tui <file.parquet> [--root <dir>]...`. It runs only when standard input and standard error are terminals. The screen and OSC 52 go to standard error, and standard output is only the Ref at exit (so it can be piped).

- The table (rows per page is decided from the screen height, at most `MAX_PAGE_ROWS`), with the file position (`file_row_number`) in the leading column. When the columns do not fit on screen, ←→ shifts them.
- Rows are selected one at a time with `space`, or with `v` to mark the start of a range and then ↑↓ to add rows (Esc ends the range). The set of positions becomes a range predicate, as in ADR 0002. When the file has its own `file_row_number` column, selection is refused.
- `/` enters a row condition (checked the same way as the Web UI's condition). If the condition does not pass, core's wording is shown and the previous condition returns. The Ref means the rows that match both the selection and the condition, so when the condition changes the selection is cleared, so that "N rows selected" and the Ref's rows do not drift apart.
- The Ref is minted again each time the selection changes, and only the latest is shown. `y` waits for a Ref that is still being minted before copying.
- Copying uses **OSC 52** (a terminal feature). No extra package or external command is used. For terminals that do not accept OSC 52 (tmux by default, for example), the Ref is always shown on screen and also printed to standard output on one line at exit (`q`, Ctrl-C) (not printed once the file is known to have changed) (`fusen-tui f.parquet | pbcopy`).
- The content of the OSC 52 sent out is only the Ref we made ourselves (ASCII only) and contains no strings from the file.

### 5. File list and column selection (addendum 2026-10-23)

- When started without a file, it lists the Parquet files under the roots. The list uses the Web UI's `listFiles` as it is, so its protections are the same too: symlinks are not followed, hidden files are skipped, and there are caps on the count and on the entries read. File names come from disk, so they go through `plain()`. Opening goes through `View.open` (the root check is core's). `b` returns to the list and closes the current `View`.
- Columns are kept or dropped on the `c` screen. The same set is passed to the table and to `View.ref`'s `columns` (the same contract as the Web UI; no contract change). Column names are passed to the Ref in their original spelling and shown on screen through `plain()`.
- Limit: `View.open` and `listFiles` take no signal, so if the terminal closes while a file is being opened or the list is being read, that one operation continues until it finishes (a finished `View` is closed immediately). Both finish within their caps and clocks.

## Consequences

- Good: a TUI you can drive with arrow keys sits on the same checks as the Web UI. We avoid writing the details of redrawing, resizing and key input ourselves.
- Bad: runtime dependencies and the lockfile grow. ink depends on React, and following major updates is needed. The effect is only inside `apps/tui`, but the supply-chain surface has widened.
- How things look in a terminal depends on the width of full-width characters and on differences in key input between terminals. In the first slice we tested an environment close to a Linux terminal emulator, and did not test interactive use on Windows and macOS (CI's `check` runs the TUI tests on all three OSes, and confirms at least that ink loads).

## First slice

"Start `fusen-tui`, select rows, and press `y`: a Ref that returns only the selected rows is copied."

Acceptance tests (`tests/integration/tui.test.ts`):
1. `resolveRef` on the Ref for rows selected with `space` and `v` returns only the selected rows.
2. Entering a condition gives a Ref for only the matching rows. A condition that does not pass is refused with core's wording and the previous condition returns.
3. Selecting a row on page 2 gives matching positions.
4. A file that has its own `file_row_number` column cannot be selected from.
5. If the file changes after it was opened, no Ref is made and a notice is shown.
6. Cells and column names containing escapes, OSC, bell and bidirectional override characters are not passed to the terminal as they are.

## Open questions (outside the slice)

- A screen to choose from a list of files under the roots (today the file is passed as an argument).
- Column selection (`cols=`).
- Checking by hand on Windows and macOS terminals.
