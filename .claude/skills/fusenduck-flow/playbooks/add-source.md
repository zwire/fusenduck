---
id: add-source
title: Add a source
phase: expand
lifecycle: tracer
kind: work
writes: [${code}, ${config}, ${fixtures}/**, ${docs}]
checks:
  - ${typecheck}
  - ${lint}
  - ${test}
  - ${test-integration}
  - ${security-test}
  - ${contract-check}
exits:
  - to: security-review
    when: the source connects to an external system or reads credentials
    on: pass
  - to: end
    when: a file-format source is merged with every rung of the ladder shown
    on: pass
---

# Add a source

## Purpose

Add a new kind of source (a file format, or a database reached through DuckDB) and prove it up the stand-in ladder, cheapest rung first. The real-source rung runs later in `release-gate`, behind a human gate.

## Parameters

- Ladder: unit tests on mapping, then generated fixtures, then the database container in CI with a read-only role, then the real source in `release-gate`.
- Credentials: read from what the user already has (environment, standard client credential files, profiles). Never store credentials ourselves.

## Steps

1. Name the source, how its tables map to datasets, how the connection is made (path, URL or read-only attach), and where its credentials come from.
2. Rung 1: write failing unit tests for the type mapping and dataset naming, keep the red output, then make them pass.
3. Rung 2: extend the generator behind `${fixtures-gen}` with the cases the format can produce (nulls, empty tables, wide tables, nested types, unicode, very large numerics, time zones, hostile strings), run `${fixtures-gen}`, and show `${test}` passing on them.
4. Rung 3, for databases: run `${test-integration}` against the CI database container as a read-only role, and show that a write statement is refused by the role itself, not only by our own guard.
5. Build the data card cheaply: for Parquet from the footer without reading data pages, for databases from the catalog plus a bounded sample. Run `${bench}` and compare the bytes and rows read with `${budgets}`.
6. Run `${security-test}` and show that the canary secret appears in no Ref, log line or output, and that PII-named columns are masked by default.
7. Write the known gaps between the stand-ins and the real source (encodings, partitioned layouts, very large objects, server settings) into the docs.
8. Land the change ([Land through a pull request](../principles.md#land-through-a-pull-request)).

## Done when

- Failing-then-passing tests for each rung reached, with the rung named; `${test-integration}` output for a database source; `${security-test}` green with the canary test; bytes and rows read against `${budgets}`; the known-gaps note in the docs; and the pull request merged after independent review.

## Reply with

- Rungs reached and what each could not show, the bench numbers, and the exit taken.
