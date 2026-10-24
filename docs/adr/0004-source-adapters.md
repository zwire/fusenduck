# ADR 0004: Cover what DuckDB can read, through source adapters

- Status: Proposed (awaiting approval)
- Date: 2026-10-24
- Verdict: go (refactor first, then CSV and NDJSON, as increments)

## Background

takumi asked whether fusenduck can go beyond Parquet (other file formats, databases), and proposed that covering what DuckDB can read fits the name of the repository. The aim is adopted: **if DuckDB can read it and a Ref to it can be reproduced, fusenduck can hand it to an agent.**

Today the code is Parquet-shaped in five places:

- `engine.ts` binds `data` with a fixed `read_parquet(...)`.
- `ref.ts` builds the base query with `read_parquet(...)` and uses `file_row_number`, a Parquet reader column, to select rows by position.
- `fingerprint.ts` reads the Parquet footer (`parquet_file_metadata`, `parquet_metadata`) and no data pages.
- `resolve.ts` and `card.ts` read the footer for sizes and run `SUMMARIZE` over `read_parquet`.
- The safeguards (`allowed_paths` listing one file, `enable_external_access=false`, `lock_configuration=true`) assume one local file and nothing else.

"DuckDB can read it" is not the same as "a Ref to it is stable", so the goal needs a rule for what counts as supported.

## Decision

### 1. A source adapter declares four things

Each kind of source is described by one adapter in `packages/core`. Anything that cannot answer all four is **out of scope** and is refused with a plain message, not guessed at.

| # | The adapter declares | Parquet today |
| --- | --- | --- |
| 1 | **Read**: the DuckDB table function and its settings | `read_parquet(path)` |
| 2 | **Fingerprint**: how a changed source is noticed, without reading more than needed | Footer: rows, size, column statistics |
| 3 | **Row address**: how one row is pointed at (`file_row_number`, a key predicate, or none) | `file_row_number` |
| 4 | **Allow**: what the engine may touch, fixed at open time and then locked | One path |

### 2. Refs carry the kind and the read settings (expand, then contract)

- Add a `src=` parameter naming the adapter (`parquet`, `csv`, `ndjson`, ...). A Ref without `src=` is read as `parquet`, so every existing Ref and the frozen Ref corpus keep working unchanged. Nothing is removed (expand-then-contract).
- Read settings that change the result (CSV delimiter, header, quote, column types, NDJSON format) are part of the Ref, never inferred at resolve time. They are stored as a canonical, sorted `opt.<name>=<value>` list and are included in the fingerprint. An auto-detected setting is detected once, when the Ref is minted, and then written into the Ref.
- Stability stays "experimental" until the CSV slice has shipped, then it is frozen with a corpus entry per adapter.

### 3. Fingerprints for formats with no footer

CSV and JSON have no metadata to read, so the fingerprint is a hash of the bytes (streamed, bounded by the size guard) together with the read settings. Modification time is not used, because it changes with a copy and does not change with some edits. The cost (a full read once per open) is shown in the card and checked against the benchmark budgets. For many files, the fingerprint covers the sorted file list and each file's own fingerprint.

### 4. Row address by kind

- Parquet: `file_row_number`, unchanged.
- CSV and NDJSON: row position in the file, exposed under the same name `file_row_number` so predicates and the `AMBIGUOUS` handling keep working. The fingerprint guards the position, as it does for Parquet.
- Multiple files: `(filename, row position)`.
- Tables from a database: only a key predicate (the "selection by predicate" of ADR 0001). A table without a key supports queries but not row selection, and says so.

### 5. Safeguards widen as an allow list, never as a switch

`enable_external_access=false` stays the default. Each adapter declares what it needs and the engine applies exactly that before `lock_configuration=true`:

- Local files and globs: the resolved paths (or directories, with `COPY TO` and `ATTACH` still refused by the engine, as ADR 0001 requires).
- Extensions (Excel, Avro, Iceberg, ...): bundled and version-pinned, or the format is refused. No extension is downloaded at run time.
- ATTACH of a DuckDB or SQLite file: read-only, one path, with a security test that a write is refused.
- Network and database servers: a separate ADR before any code. They need a host allow list, credentials read from the user's environment or standard client files and never stored or printed (a canary test must show it appears in no Ref, log or output), and a read-only role on the database side, proven by a refused write.

The existing security tests (reading other files, `COPY TO`, `ATTACH`, unlocking the configuration, spill directory, row-size limits, query clock) run against every adapter, not only Parquet.

### 6. Order

1. Adapter layer with Parquet only. Behaviour must not change; the frozen Ref corpus and all tests pass untouched.
2. CSV/TSV and NDJSON/JSON (this is the first slice below).
3. Multiple files, globs and Hive partitions.
4. Extension-based formats.
5. DuckDB and SQLite files.
6. Remote files and database servers (own ADR).

## First slice

Steps 1 and 2. Acceptance tests (evidence is command output):

1. After the refactor, all existing tests and the frozen Ref corpus pass unchanged.
2. `fusen card data.csv` prints a card; `fusen ref data.csv --where "..."` prints a Ref with `src=csv` and the read settings; `fusen resolve` returns the same rows.
3. Changing one byte of the CSV makes the old Ref answer "the data changed".
4. The same Ref resolves to the same types on another machine (settings come from the Ref, not detection).
5. The security suite passes for CSV and NDJSON, including hostile strings, a CSV that tries to name another path, and oversized cells.
6. Benchmarks: the bytes read to build a CSV card are reported against a budget set in the slice (CSV needs a full pass for the fingerprint; the budget says how large a file is accepted by default).

## Consequences

- Good: one rule decides what is supported, the Ref stays self-contained, and old Refs keep working.
- Bad: a CSV Ref is longer (it carries settings), and the first open of a large CSV costs a full read.
- Bad: the safeguards now depend on each adapter's allow list being right, so the shared security suite is mandatory for every new adapter.

## Rejected options

- Passing any DuckDB table function through: the Ref could not be reproduced and the allow list could not be fixed up front.
- Auto-detecting CSV settings at resolve time: the same Ref could return different types on different DuckDB versions.
- Using modification time as the fingerprint: it breaks on copies and misses some edits.
- Starting with databases: no stable row address, a weak fingerprint, and the safeguards would have to change first.

## Open questions

- Fingerprints for very large CSV files (sampled hash versus a full hash with a size limit).
- Whether `file_row_number` should be renamed to a source-neutral name in a later contract change.
