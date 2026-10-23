# @fusenduck/core

fusenduck's engine, Ref model and rendering. Both the CLI and the MCP server read data through this package.

| File | Contents |
| --- | --- |
| `src/engine.ts` | Opens DuckDB and applies the read-only settings (`allowed_paths`, external access banned, memory cap, configuration locked). Query timeouts |
| `src/card.ts` | The data card (row count, types, null rates, min/max, approximate distinct counts) |
| `src/fingerprint.ts` | The data fingerprint (row count, size, Parquet footer column statistics) |
| `src/ref.ts` | The Ref grammar (`parseRef` / `formatRef`), validation of predicates and queries, computing `id=` |
| `src/resolve.ts` | `mintRef`, `resolveRef`, `peek`. The `--root` check, cost limits, ambiguity detection |
| `src/render.ts` | Rendering for agents (delimiters, notice, `OMITTED:`) |
| `src/errors.ts` | `FusenError`, and `describeError`, which turns engine errors into fixed wording |

Main defaults: `DEFAULT_LIMIT` (100 rows), `DEFAULT_MAX_BYTES` (512MB), `DEFAULT_TIMEOUT_MS` (10 seconds), `DEFAULT_PEEK_ROWS` (5) / `MAX_PEEK_ROWS` (50), `MAX_AMBIGUITY_ROWS` (10,000).

For usage and the shape of the output see [docs/guide.md](../../docs/guide.md), and for the history of the decisions see [ADR 0001](../../docs/adr/0001-engine-ref-rendering.md).
