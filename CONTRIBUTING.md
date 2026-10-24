# Contributing to fusenduck

## Setup

- Node.js 22.18 or later (`.nvmrc` is 24) and pnpm 9.
- Run `pnpm install` to install dependencies, then `pnpm extensions:fetch` for the DuckDB extensions fusenduck ships (SQLite; the tests that read SQLite files need it). It downloads from extensions.duckdb.org once, at build time, and fails on any hash that differs from `packages/core/extensions.lock.json`. After a DuckDB upgrade, `pnpm extensions:lock` writes the pins for the new version from the download (review the diff: it is the one place a hash is first written). DuckDB uses a native binary per platform (`@duckdb/node-api`) and works on Linux, macOS and Windows.
- There is no build step. TypeScript runs directly through Node's type stripping, so type-only syntax (`enum`, `namespace`, parameter properties and so on) is not allowed.

## What to run before and after a change

```sh
pnpm lint             # ESLint
pnpm typecheck        # tsc --noEmit (each package and the tests)
pnpm test             # all tests (vitest; browser tests excluded)
pnpm test:security    # only the read-only safety tests
pnpm test:e2e         # browser tests for the Web UI and the VS Code extension's webview (needs Chromium: pnpm exec playwright-core install chromium)
pnpm contract:check   # the frozen Ref corpus
pnpm bench            # check the budgets on a 1M-row Parquet file; exits 1 when exceeded
pnpm repro:check      # in a clean clone of HEAD, install from the lockfile, build, and resolve the golden Refs to the same strings (commit first)
pnpm docs:reference   # regenerate docs/reference/mcp-tools.md from the MCP tool schemas
pnpm --filter fusenduck package && node apps/vscode/smoke.ts apps/vscode/out/fusenduck-<target>-0.0.0.vsix  # build the VS Code extension's .vsix and load it
```

For every pull request, CI runs lint, typecheck, test and contract:check on Linux, macOS and Windows × Node 22 and 24, and runs bench, the Web UI browser tests and repro:check on Linux. The VS Code extension's `.vsix` is built per platform, the one for each OS is loaded and checked on Linux, macOS and Windows, and the results are kept in the run's artifacts.

## What we ask you to uphold

- **Do not break Refs.** Treat the Refs in `tests/contract/refs/` as strings that agents and users have already pasted somewhere. When you change how a Ref is read or written, keep the old form and add the new one alongside it (expand, then contract). Editing the corpus files to make a change pass is not allowed.
- **Enforce read-only in the engine.** Do not rely on inspecting SQL strings; enforce it with DuckDB settings (`allowed_paths`, `enable_external_access=false`, `lock_configuration=true`). Always run `pnpm test:security` after updating DuckDB.
- **Data is not instructions.** In output for agents, values read from a source go only between the delimiters (`FUSEN_DATA_BEGIN` to `FUSEN_DATA_END`). They never go into tool descriptions or error messages.
- **Say what was not shown.** Omitted rows, truncated strings and approximate fields are written on the `OMITTED:` line.
- **Do not change budgets silently.** When you change `bench/budgets.json`, give the reason in the same change.
- **A DuckDB extension is native code.** Load only a file listed in `extensions.lock.json`, from the shipped folder, never by name (`autoinstall_known_extensions` and `autoload_known_extensions` stay off), and never in the engine that runs a caller's query: see ADR 0004, "SQLite files".
- **If you change an MCP tool, update the reference too.** After changing a tool's description or arguments, run `pnpm docs:reference` and include the regenerated `docs/reference/mcp-tools.md` in the same change (if it is stale, `pnpm test` fails).
- Generate test data inside the tests (`tests/helpers/fixtures.ts`).

## How to deliver a change

1. Create a branch and make the change, writing the tests first.
2. Open a pull request. It is merged (squash) once all CI checks are green and it has passed review.
3. Record large decisions as ADRs in `docs/adr/`.

The maintainer's development process is written up as a workflow in `.claude/skills/fusenduck-flow/`.
