# ADR 0005: Read Postgres and MySQL servers through named connections

- Status: Accepted (2026-10-24, takumi approved the record and asked to merge); sections 2, 3 and 6 amended 2026-10-24 after the CI probe (see "Probe results")
- Date: 2026-10-24
- Verdict: go (design only; no code in this change)

## Background

ADR 0004 (section 6) put Postgres and MySQL in scope "after their own ADR on profiles, credentials and the role", and fixed the frame: a Ref carries a connection profile name and never a host, user or password; credentials come from the user's environment; the database side enforces a read-only role; a row is pointed at by a key predicate; and the fingerprint is weaker than Parquet's. This ADR fills in that frame. It adds no code.

A server differs from every source so far in three ways:

- It is reached over the network, while the engine runs with `enable_external_access=false` and `lock_configuration=true` (ADR 0001, ADR 0004 section 5).
- It needs a secret, and the Ref is something people paste into chats and agents read.
- Its data can change at any time, so a Ref is not reproducible, only change-detecting.

## Decision

takumi chose the first option (A) of each of the six points.

### 1. Where a connection name is defined: a user config file

`~/.config/fusenduck/connections.toml` (`%APPDATA%\fusenduck\connections.toml` on Windows; `FUSEN_CONNECTIONS` overrides the path) maps a name to the kind and the non-secret parts of the connection:

```toml
[warehouse]
kind = "postgres"        # or "mysql"
host = "db.example.com"
port = 5432
dbname = "analytics"
user = "fusen_ro"
password_env = "FUSEN_WAREHOUSE_PASSWORD"   # where the secret is read from; never the secret itself
```

`password_env` must start with `FUSEN_` (a profile cannot name `AWS_SECRET_ACCESS_KEY` as a "password" and send it to a chosen host). The file is read only if the current user owns it and it is not group- or world-writable (as ssh does); on Windows the user-profile location is the protection. `FUSEN_CONNECTIONS` is honoured only from the user's own environment, never from a Ref, a query or an MCP argument; whoever can write the file or set that variable can point a connection anywhere, which is accepted as the user's own authority. The Ref carries the name only (see "Ref"). A name is matched case-sensitively and never doubles as a path. Names are `[a-z][a-z0-9_-]{0,31}`. A missing or unreadable name is refused with a message that says where the file is expected. The file holds no secret, so it may be committed or shared; the server settings are visible to anyone who can read it, and that is accepted.

### 2. Credentials come from the environment

The profile names the source of the secret: `password_env`, or the standard client file for the kind when it is absent (`~/.pgpass`, host-matched by libpq; for MySQL `~/.my.cnf` is read for the **password only**, and its host, socket, plugin, init-command, local-infile and ssl options are ignored). Ambient client variables that change the target or options (`PGHOST`, `PGSERVICE`, `PGOPTIONS`, `PGSSLROOTCERT`, `PGSYSCONFDIR`, `MYSQL_HOST` and the like) are ignored for these connections.

The secret is read when the connection is opened and handed to the extension through a DuckDB secret (`CREATE SECRET ... (TYPE postgres, ...)`, then `ATTACH '' ... (SECRET name)`), never inside the ATTACH string. The probe showed the string form is readable by an untrusted query (`duckdb_databases().path`, `duckdb_settings()`, `PRAGMA database_list`), while the secret form appeared in none of the catalog functions tried. It is never written to a Ref, a card, a log line, the spill directory or MCP output. Error text follows ADR 0001: the agent gets fixed wording, and driver text (scrubbed of host, user and password) goes to stderr only under the debug switch. Accepted: the secret is in the process environment and visible to anything with that process's rights.

The canary test sets a distinctive password and fails if it, the host or the connection string appears in the output of `card`, `ref`, `resolve`, the MCP tools, logs or error messages (including a failed login), **and** in the result of untrusted queries after the lock: `duckdb_databases()`, `duckdb_secrets()`, `duckdb_settings()`, `duckdb_extensions()`, `EXPLAIN`, `PRAGMA`.

### 3. Read-only: the role is authoritative; the session setting is a second line

1. **Role (authoritative)**. The DBA supplies a SELECT-only role; fusenduck checks it and refuses to open a role that can write, and does not try a write to find out. The check is a denylist run over the whole connected database, not only the requested table:
   - Postgres: table and column privileges (`has_any_column_privilege` for INSERT/UPDATE/DELETE/TRUNCATE on every table in `pg_class`), `CREATE` and `TEMP` on the database and on every schema, `rolsuper`, `rolcreaterole`, `rolcreatedb`, `rolbypassrls`, and membership of `pg_write_all_data`, `pg_write_server_files`, `pg_read_server_files` and `pg_execute_server_program`.
   - MySQL: `SHOW GRANTS` cannot be run through `mysql_query` (the extension fails to fetch its return types), so the check reads `information_schema` (`user_privileges`, `schema_privileges`, `table_privileges`, `column_privileges`) and `current_role()`. Anything beyond `SELECT` (plus `USAGE`) on the connected database is refused, including `ALL PRIVILEGES`, `FILE`, `SUPER`, `PROCESS`, `GRANT OPTION` and wildcard grants that reach other databases. MariaDB is checked separately or refused. The probe showed the SELECT-only role is clean and a role with INSERT/UPDATE/DELETE/CREATE/DROP is flagged.
   - Stated limits: the check cannot prove that no `SECURITY DEFINER` function or large-object function writes. A DBA who grants EXECUTE on such functions defeats it. The role is checked at open and can be granted more later; this is accepted, and the session setting below narrows it.
2. **Read-only transaction (second line, verified)**. An `ATTACH ... (READ_ONLY)` makes the extension open every transaction as `BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY`, so even `postgres_execute` and a writable role were refused by the server in the probe, and the same transaction gives the single snapshot section 5 needs. The `options=-c default_transaction_read_only=on` form is also accepted and may be added as a further line.
   Original wording, kept for the record: **Session (second line, only once verified)**. The mechanism is the connection option the extension supports (Postgres: `options=-c default_transaction_read_only=on` and the extension's own read-only attach, which begins `BEGIN READ ONLY`; MySQL: an init command or the extension's read-only option), not a `SET` issued after connecting. Which option works for which extension version is confirmed by the first slice's test; until it is, this layer is not claimed. A session setting can be reset by an allowed statement, so it never replaces the role.
3. **Functions that write**: `postgres_execute`, `postgres_query`, `mysql_execute` and `mysql_query` are ordinary table functions that do not obey the external-access setting. The security suite must show a query cannot call them (refused by the lock, or by blocking those names), and that, if one runs, the server still refuses the write.

Evidence is a refused write at rung 3 of the add-source ladder: a Postgres and a MySQL container in CI. Tests assert which layer fired: (a) the session layer disabled, a write is refused by the role alone; (b) a write-capable role is refused at open; (c) a write-capable role with only the session layer is not accepted as read-only.

### 4. Extensions are not downloaded; use an installed, version-pinned one or refuse

fusenduck never fetches the `postgres` or `mysql` extension at run time (ADR 0004). The adapter loads only the shipped copy: `packages/core/extensions.lock.json` holds the sha256 per DuckDB version and platform (`postgres_scanner` and `mysql_scanner` are pinned for the eight platforms), `pnpm extensions:fetch` fetches it at build time, the VS Code package carries its platform's file, and `bundledExtension` hashes the file again just before `LOAD` (a user-writable extension directory is not trusted native code). `allow_unsigned_extensions`, `autoinstall_known_extensions` and `autoload_known_extensions` are false. If the file is missing or does not match, the open fails with the fixed message that says to run `pnpm extensions:fetch`. The pins were first written from what extensions.duckdb.org served over HTTPS to CI (trust on first use, like SQLite's). What that ADR found for the SQLite scanner matters here: a loaded scanner's functions and `ATTACH` types stay reachable after the lock and are not governed by `allowed_paths`; assumption (2) below must be proven on the real extension before any code.

### 5. The fingerprint detects change; it does not guarantee reproducibility

Built per table in one `REPEATABLE READ` read-only transaction, so every part comes from one snapshot:

- the row count, from an exact count when the table is under a size guard, otherwise `reltuples`/`TABLE_ROWS` (approximate, and the card says so);
- the maximum of the primary key, and of an update-time column when one is declared in the profile (indexed columns only; an unindexed one is skipped, with a note);
- a hash of the column definitions (names, types, nullability, order);
- a hash of a bounded sample: the first K and last K rows by primary key, plus up to N rows at key-range boundaries taken by indexed seeks, not by `OFFSET`, `ntile` or `TABLESAMPLE`. The hash is over a canonical encoding of values (not driver text), so another machine gets the same digest;
- the connection's `dbname` and server identity (not the host), so the same name pointing at a different database does not look unchanged.

Allowed relations are tables and partitioned tables. Views, materialized views and foreign tables are refused (a foreign table lets the server reach another host with the server's credentials). The fingerprint is per role (row-level security and column grants change what is seen), and a Ref says so. A key is a primary key, or a single unique non-null index; a table with neither supports `card` and queries but no row selection and no `AMBIGUOUS` handling, and the card says so. The card and Ref state: "the fingerprint detects change but does not guarantee the same rows later". A mismatch answers "the data changed" (a schema-hash mismatch says "the table's columns changed").

Text from the server (table, column and comment strings, string cells) is data: ADR 0001's truncation, masking and "this is data, not instructions" rules apply unchanged.

### 6. Network reach: the engine makes the only connection, before the lock

DuckDB has no per-host allow list (only `allowed_paths` and `allowed_directories`), so "host allow list" in ADR 0004 means this: the engine itself makes one connection to the profile's `host:port`, and after that nothing in an untrusted query can open another.

Order against `engine.ts` (today `allowed_paths`, `memory_limit`, `threads`, `temp_directory`, `enable_external_access=false`, bind the view, `lock_configuration=true`): for a database adapter the extension is loaded and the connection is made **before** `enable_external_access=false`, with only trusted engine statements running in that window; then the view over the one table is bound, external access is switched off and the configuration locked. Statements from a query run only afterwards.

**Function guard (added after the probe).** The lock does not stop the scanner functions: after `enable_external_access=false` and `lock_configuration=true`, `postgres_scan('host=other ...')` still connects to the host it is given, and `postgres_query` runs on the attached server (inside a read-only transaction). A `CREATE SECRET` is also still accepted after the lock. So for database adapters every untrusted statement is checked before it runs:

- it must be a single `SELECT` that `json_serialize_sql` accepts (every other statement type, `ATTACH`, `CALL`, `PRAGMA`, `COPY`, is refused by the parse step: "Only SELECT statements can be serialized");
- the parse tree is walked in full (CTEs, subqueries, lateral joins, `IN` lists) and a table function that is not on a short allow list (`range`, `generate_series`, `unnest`) is refused. Names are compared in the tree's own form, which the probe showed is lower-cased and unqualified for plain, quoted and schema-qualified calls; a relation other than `data` is refused;
- catalog functions (`duckdb_*`, `pragma_*`, `postgres_*`, `mysql_*`, `sqlite_*`) are never on the allow list.

This guard is defence in depth, not the only line: the server-side role and the read-only transaction still stop a write, and the single `host:port` is only the connection the engine makes. What the guard cannot show is every way a future DuckDB version names a network-reaching function, so the first slice pins the DuckDB and extension versions and adds a test that lists the table functions of the loaded extensions and fails when a new network-capable one appears that is not refused.

TLS: the default is `sslmode=verify-full` for Postgres and `verify_ca` for MySQL. The MySQL probe found that the extension verifies the server only when the secret carries `SSL_CA`: `verify_ca` and `verify_identity` without it connect to a self-signed server anyway, and the hostname is never checked, so `verify_identity` is not offered. A MySQL profile that asks for a verifying mode must give `ssl_ca` (a file), and without it the open is refused with a message that says so; `sslmode = "required"` encrypts without verifying and is an explicit choice; weaker modes need an explicit profile key and the card shows a warning.

Host pinning: fusenduck resolves the host itself, refuses loopback, link-local, private, unspecified, IPv4-mapped IPv6 and metadata addresses unless the profile sets `allow_private = true` (default false), and passes the resolved IP (`hostaddr=` for Postgres; the IP for MySQL, which means the certificate's name is never compared, so MySQL offers no `verify_identity`) so the checked address is the one connected to.

Limits: one connection (the scan is configured not to open parallel connections), plus connect, statement and lock timeouts set on the connection, because the query clock's interrupt may not stop a blocked network read. The open watchdog covers a blackholed connect.

**Assumptions (probe results are in "Probe results" below; the first slice turns them into tests):** (1) a connection made before the lock keeps working after `enable_external_access=false` and `lock_configuration=true`; (2) after the lock a query cannot `ATTACH`, `DETACH`-then-reattach, open a second server connection, or reach `postgres_query`-style functions; (3) the extension honours the single-connection setting and the read-only connection option. Mind ADR 0004: a read-only `ATTACH` can be detached by an untrusted statement after the lock, which is why DuckDB files are opened as the engine's own database; the same care applies here, and the result decides between the engine-owned attach and the fallback. The fallback is to run the database adapter in a separate process whose engine holds the connection and exposes only the one view; a failing assumption returns to this ADR as "explore further", never as a loosening of the lock.

## Ref (contract change, expand only)

- `src=postgres` and `src=mysql` join `parquet`, `csv`, `ndjson` and `duckdb`. A Ref without `src=` is still Parquet. Nothing is removed.
- A Ref has no file path for these sources; the source part is the connection and table, and the engine needs an adapter with no files (`files: []`, no `realpath` or `isFile` check, no glob handling). That change to `engine.ts`/`source.ts` is part of the first slice.
- The two settings are `opt.conn=<name>` and `opt.table=<schema>.<table>`, on the same `opt.*` mechanism as the other adapters (the DuckDB-file adapter's `table` is the same option, so the name is shared). Identifiers are quoted through the engine's `ident()`; the canonical form is `schema.table` with each part quoted only when it needs it, and the Ref grammar test covers dots, quotes and case.
- The query name stays `data`: the view over the one table is the only relation a query sees; joins across tables of the server are not supported.
- Rows are selected by a predicate on the key (ADR 0001); `file_row_number` does not exist for these sources, and position-based selection is refused with a message that names the key columns.
- The Ref `id` includes the connection name; the fingerprint includes `dbname` and the server identity (section 5).
- Stability: experimental until the first slice ships, then a corpus entry per adapter is added to the frozen Ref corpus.
- A Ref is useful only where the same connection name is defined; an unknown name says which name to define and does not guess.

## First slice

Postgres first (the more common case), then MySQL as the same adapter shape. Acceptance tests (evidence is command output):

1. With a profile and a password in the environment, `fusen card` on a Postgres table prints a card; `fusen ref ... --where "id between 10 and 20"` prints a Ref with `src=postgres`, `opt.conn=` and `opt.table=`; `fusen resolve` returns those rows.
2. The canary test (section 2) passes for every command, for a failed login and for the post-lock catalog queries.
3. The three layer tests of section 3 pass; `postgres_execute`/`mysql_execute` and the `*_query` functions are unusable from a query.
4. The three assumptions of section 6 hold, and the order matches the `engine.ts` change; a second `ATTACH` or `DETACH` from a query is refused. This is run first.
5. After an insert, an update to the key maximum, or a schema change, the old Ref answers "the data changed". A change the fingerprint cannot see is shown in the test as a documented limit.
6. A table with no primary key supports `card` and queries and refuses row selection with a clear message.
7. The shared security suite passes for the adapter.

Budgets: the card reads the count, key maximum, schema and N sample rows only, with no full scan of the table; the bytes and rows read are reported against a budget set in the slice, and the connect-plus-card time has a budget in the benchmark file.

## Consequences

- Good: no secret or server address reaches a Ref, a log or an agent; the server enforces read-only, so a bug in our guard is not the only defence; the network reach is one `host:port` fixed before the lock.
- Good: nothing is downloaded at run time and no existing Ref changes.
- Bad: a Ref to a server is not reproducible and works only where the same connection name is defined; the fingerprint can miss some changes.
- Bad: until the extension is bundled, the user installs it by hand, and CI needs database containers (rung 3 of the ladder).
- Bad: the profile file is a new thing to document, and role checks differ between Postgres and MySQL (two code paths to test).

## Rejected options

- Connection names only in environment variables: easy to forget in the VS Code and Web launch environment, and a set of variables per name is hard to read.
- Standard client files only (`.pgpass`, `.my.cnf`): there is no common name, and the two kinds differ in shape.
- Plain-text secrets in the profile, or the OS keychain: the first widens leaks; the second is heavy per OS and unusable in CI and cloud sessions.
- Relying on a session read-only setting alone, or on the role check alone: the first can be reset by an allowed statement; the second has no second line.
- Bundling the extension inside this ADR: it is a larger, shared decision with SQLite.
- Hash of every row for the fingerprint: not workable for large tables.
- Opening external access fully and relying on the database role: a query could then reach other hosts.
- Running the database adapter in a separate process now: stronger isolation, but a large change; kept as the fallback if the section 6 assumptions fail.

## Evidence

- ADR 0004 sections 5 and 6 (the frame this ADR fills in) and `packages/core/src/engine.ts` (`allowed_paths`, `enable_external_access`, `lock_configuration` order).
- No spike was run: the engine behaviour in section 6 is an assumption that the first slice tests first.
- Spike code stays in `.scratch` and is not imported; the adapter is written fresh in `packages/core`.

## Probe results (CI, PR #45, Postgres 16, DuckDB 1.5.6)

Observed by `tests/integration/db-probe.ts`, which reports and does not assert:

| Question | Observed |
| --- | --- |
| Connection made before the lock still works after it | Yes (read 100,000 rows after `lock_configuration=true`) |
| Connections held with `threads=4` | 1 |
| `ATTACH` after the lock | Refused ("Attaching Postgres databases is disabled through configuration") |
| `DETACH` after the lock | Allowed (it only removes the data; re-attach is refused) |
| `INSTALL` after the lock | Refused (file system disabled) |
| `postgres_scan('host=other ...')` after the lock | **Connects** (refused only because nothing listened there) |
| `postgres_query` after the lock | Runs, in a read-only transaction |
| `postgres_execute` / `INSERT`, SELECT-only role | Refused by the server / by the READ_ONLY attach |
| `postgres_execute` / `INSERT`, writable role, READ_ONLY attach | Refused by the server's read-only transaction; the table was not created |
| `CREATE SECRET` after the lock | **Accepted** |
| Password in the ATTACH string | **Readable** from `duckdb_databases().path`, `duckdb_settings()` and `PRAGMA database_list` |
| Password when a secret is used | Not found in those, `duckdb_secrets()` or `duckdb_views()` |
| Role-check queries | Run; the writable role is flagged (1), the SELECT-only role is clean (0) |
| Parse tree (`json_serialize_sql`) | Names the function for plain, quoted, schema-qualified, CTE, subquery, lateral and `IN` forms; refuses `ATTACH`, `CALL`, `PRAGMA`, `COPY` |

What this changed: the connection-then-lock model holds for the connection itself, but not for the scanner functions, hence the function guard; the credential goes through a secret; and the read-only transaction is a verified second line.

Still open for the first slice: whether a secret created after the lock can be used by a query to reach another host (the guard refuses the functions that would use it, but this is to be tested), and how the fallback (a separate process) would be built if the guard proves too brittle.

## What the first slice does not do yet

Recorded after the first slice (the Postgres adapter, PR #46) and its independent review, so the ADR above is read as the target, not as a claim about the code:

- The `postgres_scanner` and `mysql_scanner` extensions are loaded from the shipped copy through `bundledExtension` (pinned in `extensions.lock.json` for the eight platforms, checked just before `LOAD`); `autoinstall`/`autoload` are off.
- The role check does not refuse `TEMP` (PUBLIC has it by default and it only reaches session-local tables; the read-only transaction covers it). It does refuse write access to sequences and membership of a role with superuser, create-role, create-db or bypass-RLS rights.
- The fingerprint samples the first and last 50 rows by primary key and, when the first key column is an integer, 20 rows at each of the quarter, half and three-quarter points of the key range (indexed seeks); other key types have no boundary sample. It uses only a primary key (no unique-index key, no update-time column). A change in the middle of a table that leaves the count, last key and columns unchanged is not noticed. Above 100,000 rows the count is `reltuples` (an estimate), and the mode is part of the hash.
- Timeouts: connect 10 s, and `statement_timeout`/`lock_timeout` 60 s on the connection; a query blocked on the network is stopped by the server's timeout, not by the interrupt.
- The TLS warning on the card for a weak `sslmode` is not shown; the default is `verify-full`.
- `isPrivateAddress` covers the common ranges, not every reserved block; the pin by `hostaddr` means the checked address is the one used.
- MySQL (the second slice, `packages/core/src/mysql.ts`): the same shape as Postgres. The fingerprint is one statement: count (exact up to 100,000, otherwise the `information_schema` estimate), last key, a hash of the column definitions, the first and last 50 rows and 20 rows at each quarter point of an integer first key, combined order-independently. After the lock `mysql_query` still reaches the server and `CREATE SECRET` is still accepted, so the function guard is what keeps a query from them (the `mysql_` prefix is refused). The attach is `READ_ONLY` (writes through the catalog and `mysql_execute` are refused by DuckDB, and a `delete` through `mysql_query` by the server's read-only transaction). `~/.my.cnf` and `MYSQL_*` variables are not honoured. There is no server-side statement timeout, only a connect timeout; a query blocked on the network is stopped by the interrupt only. Only `BASE TABLE`s open (not views). Stated limits of the role check: dynamic privileges (`SYSTEM_VARIABLES_ADMIN` and the like) and routine grants are not visible in `information_schema`; SELECT on other databases is allowed (it cannot write); table names match case-sensitively. The count is exact up to 100,000 rows by a bounded `count(*)` and otherwise recorded as 'more than that' (the stale `information_schema` estimate is not used). Columns are read one row each, since `group_concat` is cut at 1024 bytes.
- The TLS warning on the card for a weak MySQL `sslmode` is not shown either.
- The Web UI lists the connections and opens `kind://connection/table` typed after one; `fusen-tui` takes the same name as its argument; VS Code has the command *Open Database Table…* (a connection from a quick pick, then the table name). None of them lists a server's tables or lets the person pick a table from a list; the TUI has no connection picker. A server source has no row positions, so the pages filter by a column. The Web UI and VS Code check a server table's fingerprint on every page request (there is no file signature to skip it), which is one bounded statement of a few indexed reads each time; caching it for a few seconds is a later option. A connection file that cannot be read, or a profile that fails its checks, is left out of the list without a reason; opening it by name shows the reason.
- The MySQL timeout is still the interrupt only.

## Open questions

- Behaviour behind a proxy or tunnel with `allow_private`.
- The sample sizes K and N, and whether they are profile-tunable.
- MariaDB: supported or refused.
