---
id: bug-fix
title: Bug fix
phase: any
lifecycle: any
kind: service
writes: [${code}, ${config}, ${fixtures}/**, ${docs}]
checks:
  - ${typecheck}
  - ${lint}
  - ${test}
exits:
  - to: contract-change
    when: the root cause is the contract itself, so the fix changes a shape
    on: pass
  - to: release-gate
    when: the defect is in a released version and a patch release is wanted
    on: pass
  - to: end
    when: the fix is merged and no release is needed yet
    on: pass
---

# Bug fix

## Purpose

Fix a defect at the layer where it starts, with a regression test that pins it.

## Parameters

- Regression test: required for kept code; written before the fix.

## Steps

1. Reproduce the defect and capture the failing evidence: the command, the input, the Ref and the output, reduced to a minimal fixture produced by `${fixtures-gen}` or stored under `${fixtures}`.
2. Find the root cause by following the data through source, dataset, query, result, selection and Ref until the first wrong value appears. For an adapter problem reproduce it on the cheapest ladder rung.
3. Write a failing regression test and keep the red output.
4. Fix the root cause with the smallest change; do not edit `${contract}`, and take the `contract-change` exit if the contract is the cause.
5. Run `${typecheck}`, `${lint}` and `${test}` and keep the green output.
6. If the defect is in a released version, record it with `${changeset}`.
7. Land the change ([Land through a pull request](../principles.md#land-through-a-pull-request)).

## Done when

- The regression test output shows red then green, the suite is green, and the pull request is merged after independent review.

## Reply with

- Root cause and layer, the before and after evidence, and whether a patch release is needed.
