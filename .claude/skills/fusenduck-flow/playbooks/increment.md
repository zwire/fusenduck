---
id: increment
title: Increment
phase: expand
lifecycle: tracer
kind: work
writes: [${code}, ${config}, ${fixtures}/**, ${docs}]
checks:
  - ${typecheck}
  - ${lint}
  - ${test}
  - ${contract-check}
exits:
  - to: increment
    when: another slice of the same item remains
    on: pass
  - to: add-source
    when: the next slice is a new kind of data source
    on: pass
  - to: contract-change
    when: the slice needs a Ref, protocol, MCP tool or data card shape that the contract does not allow
    on: pass
  - to: harden
    when: the planned slices for the next release are done
    on: pass
  - to: end
    when: the slice is merged and nothing else is queued
    on: pass
---

# Increment

## Purpose

Deliver one slice of new or changed behavior in kept code: a command, an MCP tool, a rendering level, a Web UI view, an extension feature.

## Parameters

- Verification: test first for the engine, Ref, data card and safety guards; test after for the CLI, Web UI and extension surfaces.
- Contract edits: not allowed here; the slice exits to `contract-change`.

## Steps

1. Name the slice: the behavior change in one sentence, its acceptance test, the contract it touches (none expected), and whether it is on a hot path (data card generation, the Parquet footer read, result rendering, query execution).
2. Write the failing test first for engine-side behavior and keep the red output; for a surface-only slice write the test after the implementation.
3. Implement the smallest change that turns the test green. If the slice needs a change under `${contract}`, stop and take the `contract-change` exit.
4. Run `${typecheck}`, `${lint}`, `${test}` and `${contract-check}` and keep the output.
5. If the slice is on a hot path, run `${bench}` and compare with `${budgets}`; explain any increase instead of noting it.
6. If a public behavior changed, record it with `${changeset}` and update the docs.
7. Land the change ([Land through a pull request](../principles.md#land-through-a-pull-request)).

## Done when

- Red-then-green output for the new test (engine slices), the four checks pass, bench numbers against `${budgets}` for hot paths, and the pull request is merged after independent review.

## Reply with

- The slice, the evidence, the bench comparison if any, and the exit taken.
