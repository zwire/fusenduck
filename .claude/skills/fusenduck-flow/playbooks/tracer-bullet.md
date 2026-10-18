---
id: tracer-bullet
title: Tracer bullet
phase: expand
lifecycle: tracer
kind: work
writes: [${code}, ${contract}, ${config}, ${ci}, ${fixtures}/**, ${budgets}, ${docs}]
checks:
  - ${typecheck}
  - ${lint}
  - ${test}
  - ${build}
exits:
  - to: increment
    when: the path runs end to end through the CLI and the MCP adapter in CI with its checks green
    on: pass
---

# Tracer bullet

## Purpose

Build the thinnest end-to-end path in the real architecture, meant to be kept and grown: open a source, build its data card, mint a Ref for a selection, resolve it to text, through the CLI and the MCP adapter, with the walking-skeleton pipeline in CI.

## Parameters

- Verification: test first (red, then green).
- First slice: the one named in the decision record in `${adr}`.

## Steps

1. Read the decision record from `decide` and restate the first slice: the input file, the Ref, and the expected resolved text.
2. Write the end-to-end acceptance test first: generate a small Parquet or CSV file with `${fixtures-gen}`, open it, mint a Ref for a selection, resolve it, and compare with a golden text. Run it and keep the failing output.
3. Implement the thinnest path in production structure: source, dataset with data card, query, result, selection, Ref, resolve. Keep the engine behind an interface that the CLI and the MCP adapter both call, and let nothing import engine internals.
4. Put the Ref, protocol message and MCP tool schemas in the contract location `${contract}` with schema validation at every boundary.
5. Run the acceptance test again and keep the passing output.
6. Wire `${typecheck}`, `${lint}`, `${test}` and `${build}` into CI under `${ci}`, and create `${budgets}` with the first measured numbers from `${bench}`.
7. Set the safety defaults from the first commit: a read-only connection, restricted external access once the source is loaded, and one adversarial fixture that proves a write statement is rejected by the engine.
8. Land the change ([Land through a pull request](../principles.md#land-through-a-pull-request)).

## Done when

- The acceptance test output shows red then green, `${typecheck}`, `${lint}`, `${test}` and `${build}` pass, CI on the pull request is green, `${budgets}` holds measured numbers, and the change is merged after independent review.

## Reply with

- The first slice as it now runs (command and output), the CI run, the budgets recorded, and the next exit.
