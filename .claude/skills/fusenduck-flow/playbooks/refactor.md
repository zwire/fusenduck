---
id: refactor
title: Refactor
phase: any
lifecycle: any
kind: service
writes: [${code}, ${config}]
checks:
  - ${typecheck}
  - ${lint}
  - ${test}
  - ${contract-check}
exits:
  - to: end
    when: before and after evidence match and the pull request is merged
    on: pass
---

# Refactor

## Purpose

Change structure (module boundaries, the engine interface, adapter seams) without changing behavior or any contract.

## Steps

1. Record current behavior before touching anything: `${test}` output, the golden renderings, `${bench}` numbers for hot paths, and the `${contract-check}` result.
2. Change structure in small steps and run `${test}` after each; if a step needs a test that does not exist yet, add it first and run it on the old structure.
3. Repeat the step 1 evidence and compare: test results equal, bench numbers within noise of the budgets, and an empty contract diff.
4. Land the change ([Land through a pull request](../principles.md#land-through-a-pull-request)).

## Done when

- The before and after test and bench evidence match, `${contract-check}` reports no difference, and the pull request is merged after independent review.

## Reply with

- What moved, the before and after evidence, and any structure left for later.
