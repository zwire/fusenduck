# @fusenduck/tui

The TUI `fusen-tui`. Browse a Parquet file as a table in your terminal, select rows, and copy a Ref that returns only the selected rows. The design is in [ADR 0003](../../docs/adr/0003-tui-ink.md). The screen is built with [ink](https://github.com/vadimdemedes/ink) (React rendering for the terminal), and opening files, reading rows and minting Refs use the same `View` as the Web UI (`apps/web/src/view.ts`).

```sh
node apps/tui/src/index.ts [file.parquet] [--root <dir>]...
```

Only files under `--root` can be opened (default: the current directory). If you pass no file, a list of the Parquet files under the roots appears and you pick one to open. The list is the same as the Web UI's (`apps/web/src/files.ts`): symlinks are not followed, hidden files and folders are skipped, and when there are many files the list is cut and says so. The screen is drawn on standard error, so standard output can be piped (only the Ref printed at exit goes there). It will not start unless standard input and standard error are terminals.

## Controls

### File list

| Key | Action |
| --- | --- |
| `↑` `↓` (`k` `j`), `PgUp` `PgDn` | Move through the files |
| `Enter` | Open (if it cannot be opened, core's message appears under the list) |
| `r` | Reload the list |
| `q` (`Ctrl-C`) | Quit (no Ref is printed) |

### Table

| Key | Action |
| --- | --- |
| `↑` `↓` (`k` `j`) | Move between rows |
| `space` | Select or deselect the row under the cursor |
| `v` | Start a range at the cursor's row. Rows you then move over with `↑` `↓` are selected too. `Esc` ends the range |
| `a` | Clear the selection |
| `/` | Enter a row condition (`Enter` to confirm, `Esc` to cancel). Example: `amount > 100`. The Ref means the rows that match both the selection and the condition, so changing the condition clears the selection |
| `←` `→` | Shift the displayed columns |
| `c` | Open the column picker. `space` keeps or drops a column, `a` keeps all, `Enter` or `Esc` returns. A dropped column leaves both the table and the Ref (at least one column stays). The selected rows and the condition still apply |
| `b` | Go back to the file list (when you opened from the list, or started without a file; the current file's engine is closed) |
| `n` `p` (`PgDn` `PgUp`) | Next and previous page |
| `y` | Copy the Ref (OSC 52). If it is still being minted, wait and then copy |
| `q` (`Ctrl-C`; also works while typing a condition) | Quit. Prints the last Ref shown to standard output on one line (not printed once the file is known to have changed) |

On terminals that do not accept OSC 52 (tmux by default, for example), use the `Ref:` line on screen or the output at exit: `node apps/tui/src/index.ts f.parquet | pbcopy`.

## Layout

| File | Contents |
| --- | --- |
| `src/index.ts` | Entry point (arguments, terminal checks, copying via OSC 52 (to standard error), closing the engine and printing the Ref at exit) |
| `src/shell.ts` | Switching between the list and the table. Hands the `View` opened from the list to the caller, and closes it when going back and at exit |
| `src/picker.ts` | The file list screen (uses `listFiles` from `apps/web/src/files.ts`) |
| `src/mount.ts` | A thin layer that calls ink's `render` (tests can pass in a fake terminal) |
| `src/app.ts` | The screen and its controls. The only place that depends on ink |
| `src/selection.ts` | The set of selected positions and the code that merges it into ranges |
| `src/text.ts` | Sanitizing strings that come from the file before they reach the terminal (control characters, bidirectional override characters, newlines) |
