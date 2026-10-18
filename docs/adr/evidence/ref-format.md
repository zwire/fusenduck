# Spike: ref-format (THROWAWAY)

Timebox: 1 session.

Question: If I knew whether a Ref can be a self-contained string (source + canonical SQL +
predicate selection) that resolves deterministically and detects changed data, versus needing an
opaque id backed by a session store, I would build `core`'s Ref model and `fusen://` parser that way.

Observation that answers it (same fixture: 1M-row data.parquet, DuckDB v1.5.6):
1. Two equivalent SQL spellings canonicalize to the same hash (or not).
2. A Ref with a predicate selection resolves to the same rows; a non-SELECT / multi-statement
   predicate is rejected at parse time (before the engine lock).
3. After the file changes (append rows): variant A (self-describing URI) vs B (opaque id + store)
   vs A+fingerprint: what does resolve return, and does it say the data changed.
4. Selection by coordinates (row 3 of an ORDER BY result) vs by predicate (id = X) after the data changes.
5. Ref length for realistic queries.

Variants: A = self-describing URI. B = opaque id + session store. C = A plus a data fingerprint (hybrid).

## Attempts

Fixture: data.parquet = 1,000,000 rows x (id BIGINT, region VARCHAR, amount DECIMAL), DuckDB v1.5.6,
engine locked as in engine-basics (allowed_paths + enable_external_access=false + lock_configuration=true).
Code: probe.mjs, probe2.mjs (THROWAWAY).

### 1. Canonical query hash (json_serialize_sql)
Tried: sha256 of json_serialize_sql(sql). Observed: first run a != b (case/whitespace only) because the
JSON carries `query_location` offsets. After dropping `query_location` keys: a==b TRUE (hash 387bb1fcf246 for
both `select id,amount from ... where amount>1000` and the reformatted upper-case version).
Still different hashes: column order (31c8a122d7d7), 1000 vs 1000.0 (7b98e036ff15), flipped comparison plus
redundant alias (a9398a50b668). Concluded: canonical form = AST minus locations gives a cheap, stable
normalization for formatting only. It does NOT detect semantic equivalence. That is acceptable for
content-addressing (a miss only means two ids for one meaning). json_serialize_sql is an engine feature,
so the hash depends on the DuckDB version: pin the version into the hash or accept ids change on upgrade.

### 2. Predicate selection and injection
Observed: `json_serialize_sql` rejects non-SELECT text ("Only SELECT statements can be serialized to json!") and
syntax errors, so `; COPY ...`, `; DROP ...`, and an unbalanced `) UNION ALL ...` are all REJECTED at parse
time. But a well-formed SELECT subquery in the predicate parses fine:
- `id IN (SELECT 1 FROM read_csv('/etc/hostname'))` parse ok, exec ERR "file system operations are disabled by configuration"
- `id = 1 OR (SELECT count(*) FROM '/etc/passwd') > 0` parse ok, exec ERR (table does not exist)
- `id < 3 AND (SELECT count(*) FROM (SELECT * FROM F a, F b)) > 0` parse ok and it ran (returned rows 0..2
  quickly: a count over a 1M x 1M cross join was planned away). A predicate can add cost the base query does not have.
Concluded: a predicate must be treated as arbitrary SQL. The parse check (single SELECT) is a cheap early
reject; the engine lock is the guarantee (never rely on the parse check, per "read-only by construction").
The cost guard has to run on the resolved query (base + predicate), not on the base alone.

### 3. Data changes between Ref creation and resolution
Setup: Ref made on the 1M-row file, then the file replaced by a version with 3 extra rows (ids 10000000..10000002,
amounts 9999999.0+) so the order by amount changes.
- A (self-describing URI, no fingerprint): resolved, result differed from before, nothing in the Ref or the
  result says the data changed. Silent drift.
- B (opaque id + session store): lookup works in-session (hit); with a fresh store (restart) it MISSES. The id is
  only 12 hex chars, but alone it does not carry the query, so it cannot be recovered from a pasted prompt.
- C (A plus fingerprint sha(num_rows:file_size) from parquet_file_metadata + stat): fingerprint 0afac6842ebe -> 6da53b1bcb1b,
  change DETECTED. Fingerprint here is a footer-only read (no scan). It would miss a same-size, same-row-count edit
  (not tested); a footer hash or file mtime/etag for remote sources is a candidate.

### 4. Coordinates versus predicate after the change
Selection "rows 3..7 of ORDER BY amount DESC" (LIMIT 5 OFFSET 2):
before ids [999996, 999995, 999994, 999993, 999991]; after the 3-row insert [10000000, 999998, 999997, 999996, 999995].
Same coordinates, different rows. Selection by predicate `id IN (...)` after: [999996, 999995, 999994, 999993, 999991],
the same rows as before. Concluded: predicate selection survives data change; coordinates do not. This confirms the
design note in the vision (4: selection as predicate), with the requirement that a Result needs a key column or a
stable row identity (here `id`). Not tested: tables with no key (what predicate selects "this row"?).

### 5. Ref length
A (self-describing, path + SQL percent-encoded): 295 chars for a 100-char query and 410 chars for a 200-char query,
of which ~86 are the absolute path. B (opaque id): 65 chars including a predicate. Neither is a problem for a prompt;
A grows with the query and contains the local absolute path (privacy/portability: a Ref pasted to another machine
holds a path that does not exist there).

## Answer
Neither A nor B alone. Recommended shape, to be settled in `decide`: a hybrid. A Ref = short id (hash of canonical AST
without locations + engine version) that is ALSO resolvable without a store, because the query text travels with it
(or is recoverable from a local store keyed by the id), plus a data fingerprint so resolve reports "data changed"
instead of silently returning different rows. Selection is stored as a predicate over key columns, never as
coordinates. Predicate text is untrusted SQL: parse-check as a single SELECT, then rely on the engine lock and
run the cost guard on the combined query.

Not answered (needs another spike or a decision): how an agent actually uses these strings (no model was run, so
"agent readability" is untested), Refs on sources without a key column, remote sources (S3/HTTP) fingerprints, and how
Refs behave when the base file moves.

## Throwaway label and shortcuts
probe.mjs, probe2.mjs are THROWAWAY. Shortcuts: absolute paths, one fixture, fingerprint = row count + file size only,
no URL grammar (the URI strings were built with encodeURIComponent only, no parser written), no real session store
(a JS Map), hash truncated to 12 hex chars with no collision handling, no agent in the loop.
