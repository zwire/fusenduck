---
id: harden
title: Harden
phase: expand
lifecycle: tracer
kind: work
writes: [${code}, ${config}, ${ci}, ${docs}, ${budgets}]
checks:
  - ${typecheck}
  - ${lint}
  - ${test}
  - ${test-integration}
  - ${bench}
  - ${security-test}
exits:
  - to: security-review
    when: no security report exists for the current commit
    on: pass
  - to: release-gate
    when: the security report covers the current commit and the shortcut list is empty or accepted
    on: pass
---

# Harden

## Purpose

Raise kept code from tracer quality to release quality: pinned behavior, closed shortcuts, robust operation on every supported platform, documentation a stranger can follow, and numbers inside their budgets.

## Parameters

- Platforms: the Node versions and operating systems the project claims to support, declared in the CI configuration under `${ci}`.
- Budget changes: allowed only with a written reason in the same change.

## Steps

1. Pin current behavior: add characterization and golden tests for kept code that came from the tracer without tests, and run `${test}` before changing anything else.
2. Close the shortcuts listed in the decision records under `${adr}`: error messages that say what to do next, input validation at every boundary, configuration out of code.
3. Make operation robust: deterministic ordering of output, timeouts and cancellation, clear CLI exit codes, structured logs without secrets.
4. Extend CI under `${ci}` to the supported platform matrix, including the native DuckDB binaries on each.
5. Write the docs a stranger needs: README quickstart, contributing guide, security policy with a private reporting channel, per-package READMEs, and the contract reference generated from the schemas.
6. Run `${bench}` against `${budgets}`; fix every number over budget or change the budget with a written reason.
7. Run `${repro-check}` and keep its output: a clean clone builds from the lockfile and resolves the golden Refs to identical text.
8. Land the change ([Land through a pull request](../principles.md#land-through-a-pull-request)).

## Done when

- Characterization tests are green, the bench table shows every number within `${budgets}`, `${repro-check}` output is kept, CI is green on every platform in the matrix, the docs listed above exist, and the pull request is merged after independent review.

## Reply with

- Shortcuts closed, the bench table, the platform matrix result, and the exit taken.
