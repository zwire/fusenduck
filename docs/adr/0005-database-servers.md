# ADR 0005: Read Postgres and MySQL servers through named connections

- Status: Proposed (2026-10-24, waiting for takumi's approval of the record; takumi approved the six choices below as the recommended option in each case)
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

The Ref carries the name only (see "Ref"). Names are `[a-z][a-z0-9_-]{0,31}`. A missing or unreadable name is refused with a message that says where the file is expected. The file holds no secret, so it may be committed or shared; the server settings are visible to anyone who can read it, and that is accepted.

### 2. Credentials come from the environment

The profile names the source of the secret: `password_env` (an environment variable), or the standard client file for the kind (`~/.pgpass` for Postgres, `~/.my.cnf` for MySQL) when `password_env` is absent. The secret is read when the connection is opened and handed to the extension; it is never written to a Ref, a card, a log line, an error message, the spill directory or the MCP output. A connection string that DuckDB builds is never printed; error text from the driver is passed through a scrubber that removes the host, user and password before it reaches the user. A canary test sets a distinctive password and fails if it (or the connection string) appears anywhere in the output of `card`, `ref`, `resolve`, the MCP tools, logs, or error messages, including a failed login.

### 3. Read-only is enforced twice, and the role is checked

1. **Role**: the profile's user must be unable to write. At open time the adapter asks the server what the role can do (Postgres: `has_table_privilege` and `has_schema_privilege` for INSERT/UPDATE/DELETE/TRUNCATE/CREATE, and `rolsuper`/`rolcreatedb` in `pg_roles`; MySQL: `SHOW GRANTS`) and refuses to open if it can write. It does not try a write to find out.
2. **Session**: right after connecting, set the session read-only (Postgres: `default_transaction_read_only=on`; MySQL: `SET SESSION TRANSACTION READ ONLY`). This is a second line, not a substitute for the role, because a session setting can be reset by a statement the role is allowed to run.

Evidence is a refused write at rung 3 of the add-source ladder: a Postgres and a MySQL container in CI where a write through the adapter is rejected **by the server** (the error is the server's permission error, not our guard's message). A second test connects with a role that has write rights and asserts the adapter refuses to open.

### 4. Extensions are not downloaded; use an installed, version-pinned one or refuse

fusenduck never fetches the `postgres` or `mysql` extension at run time (ADR 0004). The adapter loads it only if it is already installed in the local DuckDB extension directory and its version matches the DuckDB version the engine is built with. If not, the open fails with the exact install step and says the extension is not bundled. Bundling (per-OS fetch, hash pinning, recreating it for the VS Code extension) is a separate piece of work shared with SQLite, tracked in ADR 0004, and not decided here.

### 5. The fingerprint detects change; it does not guarantee reproducibility

Built per table, in one read-only transaction:

- the row count,
- the maximum of the primary key, and of an update-time column when the table has a column named by convention (`updated_at`, `modified_at`) or declared in the profile,
- a hash of the column definitions (names, types, nullability, order),
- a hash of a bounded sample: the first, last and N evenly spaced rows by primary key (N is fixed in the adapter; a table with no primary key has no sample and no row selection).

The card and the Ref state: "the fingerprint detects change but does not guarantee the same rows later". A Ref whose fingerprint differs answers "the data changed", as for other sources. Changes that leave the count, key maximum, schema and sample unchanged are not noticed; this is the accepted weakness, recorded as a limit in the guide.

### 6. Network access is an allow list fixed at open time

`enable_external_access=false` stays the default for every other adapter. For a database adapter the engine, **before** `lock_configuration=true`:

1. resolves the profile and checks it is on the machine's own list (it came from the user's config file, never from the Ref or a query),
2. loads the pinned extension and makes the single connection to that one `host:port` (an `ATTACH ... (TYPE postgres|mysql, READ_ONLY)` made by the engine itself),
3. applies the allow list, then locks the configuration.

After the lock a user query cannot `ATTACH`, `DETACH`, `COPY TO`, `INSTALL`/`LOAD`, or change settings, so it cannot reach another host or reconnect with other rights. The existing security suite (other paths, `COPY TO`, `ATTACH`, unlocking the configuration, row-size limits, the query clock) runs against these adapters.

**Assumption to prove first**: that a connection made before the lock keeps working after `enable_external_access=false` and `lock_configuration=true`, and that the lock really prevents a second connection. This is the first test of the first slice. If it fails, the fallback is to run the database adapter in a separate process with its own engine, which this ADR does not choose now; a failing result returns here as "explore further", not as a loosening of the lock.

An optional profile key `allow_private = false` (default) refuses a host that resolves to a loopback, link-local or private address, to reduce use as a path into an internal network. It is set to `true` for a local container or an internal database. The check is on the address actually connected to, not only the name.

## Ref (contract change, expand only)

- `src=postgres` and `src=mysql` are added next to `parquet`, `csv`, `ndjson` and `duckdb`. A Ref without `src=` is still Parquet. Nothing is removed.
- `conn=<name>` is the connection name; `tbl=<schema>.<table>` the table. No host, user, password or connection string appears in a Ref.
- Rows are selected by a predicate on the primary key (ADR 0001 selection by predicate); `file_row_number` does not exist for these sources. Position-based selection is refused with a message that names the key columns.
- Stability: experimental, the same as the other adapters, until the first slice ships; then a corpus entry per adapter is added to the frozen Ref corpus.
- A Ref is useful only on a machine whose config defines the same name. A Ref that names an unknown connection says so and says which name to define; it does not guess.

## First slice

Postgres first (the more common case), then MySQL as the same adapter shape. Acceptance tests (evidence is command output):

1. With a profile and a password in the environment, `fusen card` on a Postgres table prints a card; `fusen ref ... --where "id between 10 and 20"` prints a Ref with `src=postgres`, `conn=` and `tbl=`; `fusen resolve` returns those rows.
2. The canary test (section 2) passes for every command and for a failed login.
3. A write through the adapter is refused by the server; a role with write rights is refused at open.
4. The connection-then-lock assumption (section 6) holds; a second `ATTACH` from a query is refused.
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
- Running the database adapter in a separate process now: stronger isolation, but a large change; kept only as the fallback if the lock assumption fails.

## Evidence

- ADR 0004 sections 5 and 6 (the frame this ADR fills in) and `packages/core/src/engine.ts` (`allowed_paths`, `enable_external_access`, `lock_configuration` order).
- No spike was run: the engine behaviour in section 6 is an assumption that the first slice tests first.
- Spike code stays in `.scratch` and is not imported; the adapter is written fresh in `packages/core`.

## Open questions

- How the extension is bundled and pinned per OS (shared with SQLite).
- Whether `allow_private` should default to refusing, and how it behaves behind a proxy or tunnel.
- TLS settings (`sslmode`, CA file) in the profile.
- Whether the sample size N should be profile-tunable.
