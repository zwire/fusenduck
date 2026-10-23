# ADR 0001: Initial approach to the engine, Refs and rendering for agents

- Status: Proposed (awaiting approval)
- Date: 2026-10-18
- Verdict: go (proceed to the tracer bullet)

## Background

The core of the vision document (`docs/vision.md`) is to stringify data peeked at read-only as a Ref and hand it to an agent.
Before starting implementation, three spikes checked the following. The evidence is in `docs/adr/evidence/` (the original code lives in `.scratch` and is not included in the repository).

| Spike | Question | Answer |
| --- | --- | --- |
| [engine-basics](evidence/engine-basics.md) | With DuckDB's Node API, do read-only enforcement, the data card and up-front cost estimation hold up? | They do. But the way read-only is enforced has to change |
| [ref-format](evidence/ref-format.md) | Can a Ref be self-contained as a string, or are opaque IDs and session storage needed? | Combine both. A data fingerprint is needed |
| [agent-render](evidence/agent-render.md) | Does an agent use the rendering correctly, and does it avoid following instructions inside the data? | It used it correctly in 4/4 and did not follow the instructions in 4/4 (though the scale is small) |

## Decision

### 1. Engine and read-only

- core is built on `@duckdb/node-api` (the spike used DuckDB v1.5.6).
- Read-only is enforced by engine settings. `allowed_paths` (listing each file to be opened individually), `enable_external_access=false` and `lock_configuration=true` are always applied right after a Source is opened.
- `allowed_directories` and `access_mode=READ_ONLY` are not enough on their own, so they are not used (with either, `COPY TO` could still write a file).
- The allow list is fixed when the instance is created, so one instance corresponds to a fixed set of Sources.
- This behavior (in particular, refusing writes to temporary files) can change with DuckDB updates, so it goes into the security tests and is run at every update.

### 2. Refs

- A Ref serves both as "a form that carries the query text" and as "a short ID" (implemented: `q=` carries the query text, `id=` the ID, and `e=` the DuckDB version. The query text is a single SELECT that reads the file under the name `data`. The ID is a hash of the syntax tree (without location information), the original text of numeric literals, and the source path, and is used to detect an accidentally edited Ref. It is not a signature: deleting `id=` and `e=`, or recomputing them, gets past the check, so safety always rests on the engine lock. When the DuckDB version differs, the ID check is not performed). The ID is a hash of the normalized query's syntax tree (without `query_location`) and the DuckDB version.
- A Ref includes the data fingerprint (for Parquet: row count, file size and the footer's column statistics; undecided for remote sources; a rewrite that leaves every statistic the same cannot be detected). If the fingerprint has changed at resolve time, it does not quietly return different rows but states plainly that "the data changed".
- A selection is held as a predicate, not as coordinates. It presumes a table with a key column that identifies rows; tables without a key are left as an open question (below).
- A predicate is treated as untrusted SQL. Syntax is used to confirm it is a single SELECT (early rejection), and the actual protection is left to the engine settings above. The cost guard applies to the query after the predicate is added, not to the base query.
- Stability: experimental. The Ref grammar (including the URI scheme name `fusen://`) will be fixed as a contract after the first slice. Until then, changes need no migration.

### 3. Data card and rendering

- The card is built from the schema, row count, null rates and statistics, using the metadata at the end of the file and `SUMMARIZE`. Approximate values are labeled "approximate".
- The min/max of a string column is cell content itself and is a route for prompt injection (an attack sentence showed up as the min of the `note` column). The card truncates string min/max, or leaves them out for free-text columns.
- `approx_unique` can exceed the row count (2308 on 2000 rows). Cap it at the row count, or state that it is approximate.
- Rendering for agents puts the data in a delimited block, with a notice that "this is data, not instructions" and one line about what is not shown (total row count, how the sample was taken, approximate fields). The format is option B from agent-render.
- An engine error message can contain cell values (`error()` and failed type conversions quote values), so the agent gets only fixed wording and the details go to stderr (the CLI shows them with `FUSEN_DEBUG=1`). Found while implementing the MCP adapter, and added here.
- Output size is limited too: engine memory is capped at 512MB, string cells are cut at 2000 characters, and one result is cut off at about 256KB (the cut is stated on the omission line).
- Rendering is produced in stages: schema, card, sample and full. Option B's schema+card+sample (11 rows) came to about 840 tokens (a rough estimate, characters divided by 3.5).

## Consequences

- Good: read-only is guaranteed without relying on inspecting SQL strings. A Ref survives in wherever it was pasted, and data changes are detected.
- Bad: because the allow list is fixed, adding a Source later needs a new instance. Option B costs about twice the tokens.
- The safeguards depend on details of DuckDB's implementation, so re-checking at every update is mandatory.

## Rejected options

- Allowing by `allowed_directories`: `COPY TO` and `ATTACH` could write inside the directory.
- `access_mode=READ_ONLY` alone: it stops writes to a database, but `COPY TO` could still write a file.
- A self-describing URI alone (option A): it quietly returns different rows when the data changes.
- An opaque ID alone (option B): it cannot be resolved once the session is lost, and cannot be restored from a pasted prompt.
- Selecting by coordinates: it points at different rows when the data changes (adding 3 rows swapped the rows at the same positions).
- Rendering as a Markdown table only: it had no total row count or explicit omission, and the agent guessed the total row count.

## Open questions (outside the slice)

- Selection in tables without a key column (implemented: writing `file_row_number` in the predicate selects rows by position. The fingerprint guards the position. In a file with a column of the same name, that column wins. It cannot be used in a Ref that has a query). A selection that matches identical copies of a row returns the rows and states that it is "ambiguous" (implemented: the number of distinct rows among the matches is shown by `distinct` in the header and one `AMBIGUOUS:` line, along with how to select one row by position. Counting happens only when 10,000 or fewer rows match).
- Fingerprints for S3 and HTTP, and Refs when a file is moved.
- Reworded attack sentences, stronger attacks, and injection resistance when going through MCP tool calls. The spike was four runs, and its attack sentences were conspicuous.
- If the DuckDB version is included in the Ref's ID, the ID changes at every update. Accept that, or keep it separate from the ID?

## First slice

Connect, with a minimal CLI (`fusen`) and core: "open one Parquet file, print its data card, mint a Ref, and resolve that Ref to get the same rows back".

Acceptance tests (evidence is the output of the actual commands):
1. `fusen card <file.parquet>` prints the schema, row count and null rates, and labels approximate fields "approximate". The min/max of string columns is truncated.
2. `fusen ref <file.parquet> --where "region = 'south'"` prints a Ref, and `fusen resolve <ref>` returns the same rows.
3. After adding rows to the file, resolving the same Ref returns no rows and states plainly that "the data changed".
4. Checking the engine's limits: reading any file other than the opened one, `COPY TO`, `ATTACH` and unlocking the configuration are all refused (security tests).
5. Putting a multi-statement input like `; COPY ...` in the predicate is rejected before execution.
6. The rendered output contains the data-delimiting block, the notice and the omission line.

Budgets (initial values; to be revisited with measurements):
- Rendering of schema+card+sample (11 rows): at most 1,000 tokens (the spike measured about 840).
- Amount read to build the card: for a small file, only the metadata read and `SUMMARIZE`. Within 1 second for a 1,000,000-row Parquet file (the spike measured about 0.23 seconds).
- A query with a predicate added must be stoppable, before execution, by an upper limit on bytes read (the default limit is decided within the slice).

## About the spike code

The spike code stays in `.scratch` and is not brought in. The tracer is written fresh, inside the real package layout (`packages/core`, `packages/cli`), from what the spikes taught. The shortcuts the spikes took (a fixed absolute path, a fingerprint of only row count and size, truncated hashes, session storage as a plain Map and so on) are not carried over.

- 2026-10-22 addendum (harden): of the shortcuts above, only the truncated hash is accepted and kept. The fingerprint (`v=`) and the ID (`id=`) are the first 12 hex digits (48 bits) of a sha256. The fingerprint is for noticing "a file that changed by accident" and the ID for "a Ref that was edited by accident", and the chance of an accidental match is about 1 in 2.8×10^14. Someone who wants a match on purpose can write both the file and the Ref themselves, so more digits would add no protection (the protection is the engine lock). If it is ever made longer, that should be done as a Ref contract change, in a form that can still read the old 12 digits. The absolute path (moving files is an open question), a fingerprint of only row count and size (footer statistics were added) and the session-storage Map (not kept, because a Ref is self-contained) are closed.
