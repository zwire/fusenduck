# ADR 0004: Cover what DuckDB can read, through source adapters

- Status: Accepted (2026-10-24, takumi approved)
- Date: 2026-10-24
- Verdict: go (refactor first, then CSV and NDJSON, as increments)

## Background

takumi asked whether fusenduck can go beyond Parquet (other file formats, databases), and proposed that covering what DuckDB can read fits the name of the repository. The aim is adopted: **if DuckDB can read it and a Ref to it can be reproduced, fusenduck can hand it to an agent.**

Before step 1 the code was Parquet-shaped in five places (step 1 moved the read, fingerprint, scan-byte count, row-position column and allowed paths behind `engine.adapter`; the text of messages and the Web view's `file_row_number` handling still name Parquet and move with the CSV step):

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
- Extensions (Excel, Avro, Iceberg, ...): bundled and version-pinned, or the format is refused. No extension is downloaded at run time. The mechanism is `packages/core/extensions.lock.json` (DuckDB version, platform, URL, sha256 of the download and of the file), `pnpm extensions:fetch` at build time, and a hash check just before `LOAD`; autoinstall and autoload stay off. See "SQLite files" below for what loading a scanner extension does to the lock.
- A DuckDB or SQLite file: read-only, one path, with a security test that a write is refused. A DuckDB file is the engine's own database; a SQLite file is copied by a throwaway engine first ("SQLite files" below).
- Network and database servers (Postgres, MySQL, through DuckDB's scanner extensions): a separate ADR before any code. See "Databases through DuckDB" below.

The existing security tests (reading other files, `COPY TO`, `ATTACH`, unlocking the configuration, spill directory, row-size limits, query clock) run against every adapter, not only Parquet.

### 6. Databases through DuckDB

Databases are in scope when DuckDB can read them (DuckDB files, SQLite, and Postgres/MySQL through DuckDB's extensions). They are adapters like any other and must declare the same four things.

- **Read**: a read-only `ATTACH` of exactly one database, with the scanner extension bundled and version-pinned. No extension is downloaded at run time.
- **Row address**: a key predicate only. A table without a primary key supports queries but not row selection, and says so.
- **Fingerprint**: no footer exists, so it is built from the row count, the maximum of a key or update-time column when one exists, and a bounded sample hash. The Ref states that the fingerprint detects change but does not guarantee reproducibility.
- **Ref**: carries a connection profile name, not a host, user or password. The profile is resolved from the user's own environment (environment variables or standard client files). Credentials are never stored, printed or put in a Ref; a canary test must show they appear in no Ref, log line or output.
- **Allow**: a host allow list fixed at open time, and a read-only role on the database side, proven by a refused write at rung 3 of the add-source ladder (a database container in CI), not only by our own guard.
- **Order inside this step**: SQLite and DuckDB files first (a single local file, safe to test); Postgres and MySQL only after their own ADR on profiles, credentials and the role (decided in [ADR 0005](0005-database-servers.md)).

### 6a. SQLite files

A SQLite file is read through DuckDB's `sqlite_scanner` extension, which is shipped and pinned (above). Observed on the real extension (DuckDB 1.5.6, linux_amd64), with `allowed_paths` set to one file, `enable_external_access=false` and `lock_configuration=true`:

- `sqlite_scan('/etc/passwd', 'x')` reached SQLite's open and failed with "file is not a database": the allow list did not stop it, so any other SQLite file on disk is readable by name.
- `ATTACH 'file.sqlite' AS s (TYPE sqlite)` succeeded after the lock, and an attach is read-write unless it says `READ_ONLY`.

The extension opens files with SQLite's own file access, which neither setting governs, and a loaded extension's functions cannot be unloaded. Blocking the names in SQL text would be the only guard, which ADR 0001 and "Read-only by construction" rule out as the sole defence. So the engine that runs a caller's query never has the extension loaded:

1. The source file (and its `-wal` log, when one is a regular file next to it; links and pipes are skipped) is copied into a private folder (`mkdtemp`, mode 0700), read without following links and without blocking on a pipe. SQLite writes `-shm`/`-wal` beside a database it reads, so reading the copy keeps the user's folder untouched, and a database being written is read as of the copy.
2. A throwaway engine loads the pinned extension, attaches the copy `READ_ONLY`, lists the tables and views of the main schema (`ManyTables` when none is named), and `CREATE TABLE AS` copies the one table into a DuckDB file in that folder. It runs fixed statements and no text from a caller; a table name goes in as a quoted identifier.
3. The query engine opens that DuckDB file as its own read-only database, exactly as for a `.duckdb` file. The folder is removed when the engine closes or opening fails.

Costs, accepted: the first open of a file copies the table (bench: 40 MB / 1,000,000 rows opens, builds a card and mints a Ref in about 3 s, two copies; budget 9 s). Engines of one process share one copy of an unchanged file and table, keyed by the real path, size, inode, modification and change time of the file and its `-wal` (a user cannot set the change time back) and the table; it is reference-counted, kept 30 s after the last engine closes (at most 4 idle), and removed at exit. A file touched within the last 2 s is never shared, since a write right after the copy could keep every timestamp on a coarse clock. A second open of an unchanged file takes about 25 ms. Nothing is kept across processes (a persistent cache would hold a copy of the data after the tool is gone); a file over 512 MB is refused with a message; the copy has a 60 s clock; a crash can leave a folder in the temporary directory. Row address, fingerprint and `scanBytes` are the DuckDB-file ones on the copy (key column only; the fingerprint is the row count and an order-independent hash of the rows, because the storage layout of the copy varies between copies), with the kind `sqlite` in the Ref (`src=sqlite&opt.table=...`). SQLite's own parser still reads the user's file: a malformed file is SQLite's to reject; fusenduck maps its errors to fixed wording.

The same reasoning applies to the Postgres and MySQL scanners ([ADR 0005](0005-database-servers.md)): an engine that holds a connection and runs a caller's text must not also have functions that open another one; the shape for them is decided there.

### 7. Order

1. Adapter layer with Parquet only. Behaviour must not change; the frozen Ref corpus and all tests pass untouched.
2. CSV/TSV and NDJSON/JSON (this is the first slice below).
3. Multiple files, globs and Hive partitions.
4. Extension-based formats.
5. DuckDB and SQLite files (a DuckDB file as the engine's own read-only database; a SQLite file as a copy, see 6a).
6. Remote files, and Postgres/MySQL servers (own ADR first).

## First slice

Status: steps 1 to 3 and the DuckDB-file part of step 5 are implemented (DuckDB files are opened as the engine's own read-only database rather than by ATTACH, because after the configuration lock an untrusted statement could detach a read-only ATTACH and attach the same file read-write; SQLite followed once the extension could be fetched and pinned, as a copy read by a DuckDB file: see 6a). Steps 1 to 3 (step 3: a wildcard in the file name, up to 256 files, fingerprint over the file list; Hive partitions and recursive globs are left out). Steps 1 and 2 were implemented (PR #38 for step 1; the CSV/NDJSON/JSON adapters, `src=` and `opt.*`, the text-source tests and the `csv_open_card_mint_ms` budget for step 2). JSON that is one array is read with `format=auto`; its row position and fingerprint behave like NDJSON.

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
- Starting with databases: no stable row address, a weak fingerprint, and the safeguards would have to change first. They stay in scope, later in the order.

## Open questions

- Fingerprints for very large CSV files (sampled hash versus a full hash with a size limit).
- Whether `file_row_number` should be renamed to a source-neutral name in a later contract change.
