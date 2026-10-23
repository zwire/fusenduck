# @fusenduck/cli

The CLI `fusen`. It is not published yet, so run it from the repository with `node packages/cli/src/index.ts`.

```
fusen card <file.parquet>
fusen peek <file.parquet> [--rows <n>]
fusen ref <file.parquet> [--query <select over data>] [--where <predicate>] [--columns a,b]
fusen resolve <ref> [--limit <n>] [--root <dir>]...
fusen --help | --version
```

| Command | Output |
| --- | --- |
| `card` | The data card. No row values |
| `peek` | The card, the first `--rows` rows (default 5, maximum 50) and a Ref for the whole file |
| `ref` | A `fusen://` Ref that stands for the selection. `--query` is a single SELECT that reads the file as a table named `data` |
| `resolve` | The rows of a Ref (up to 100 by default). If the data changed, it returns `DATA_CHANGED` and no rows. It opens only files under `--root` (default: the current directory) |

On success the result goes to standard output and the exit code is 0 (also 0 for a `DATA_CHANGED` result). On failure it prints `fusen: <reason>` to standard error and exits 1. A command-line mistake prints the reason and the usage and exits 2. A mistake in your own `--where` or `--query` (such as a missing column) is shown as the reason as is. Engine error messages can contain cell values, so they are withheld by default; `FUSEN_DEBUG=1` shows the details.

See [docs/guide.md](../../docs/guide.md) for more.
