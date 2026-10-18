---
id: release-gate
title: Release gate
phase: extract
lifecycle: any
kind: gate
promotes: tracer->hardened
writes: [${docs}]
checks:
  - ${typecheck}
  - ${lint}
  - ${test}
  - ${test-integration}
  - ${bench}
  - ${security-test}
  - ${contract-check}
  - ${repro-check}
  - ${pack-dry-run}
irreversible:
  - ${real-source-trial}
exits:
  - to: release
    when: every checklist row has linked evidence, the real-source trial ran clean and every check passed
    on: pass
  - to: security-review
    when: no security report covers the candidate commit
    on: pass
  - to: end
    when: the user rejected the real-source trial or stopped the release
    on: pass
  - to: harden
    when: a check failed, so the candidate goes back to hardening
    on: fail
---

# Release gate

## Purpose

Promotion gate from `tracer` to `hardened`. Decide with linked evidence whether a candidate commit is fit to be released to people who will depend on it, including one run against a real source the user chooses.

## Parameters

- Approver: the user, at the real-source trial.
- Report: a release report under `${docs}`, one row per checklist item with its evidence.
- Real source: a read-only source the user names, with a read-only role or read-only file access; the user provisions it ahead of time.

## Steps

1. Pin the candidate: the commit on `${trunk}`, and confirm through the VCS host that pull requests, required CI and independent review were used for every change since the last release.
2. Start the release report under `${docs}` with one row per item below and fill each with linked output: behavior tests, characterization tests for code that came from the tracer, independent review of the diff since the last release in a fresh agent context, the schema diff from `${contract-check}` with each break matched to a changeset, the budget table from `${bench}`, the security report for this commit, and the `${repro-check}` output.
3. Read the file list of every package from `${pack-dry-run}` and confirm no fixtures, credentials, scratch files or environment files are included.
4. Confirm the docs promise only what the tests show: the quickstart runs as written, and the known gaps of each stand-in are listed.
5. [human-gate] The user names the real source for the trial, confirms the access is read-only, and approves running it.
6. [irreversible] Run `${real-source-trial}` once against that source and keep its output: rows and bytes read, durations, and the data card and a resolved Ref it produced.
7. Compare the real run with the container rung: explain each difference, and reproduce any failure on the cheapest rung that shows it before fixing.
8. Write the verdict into the report: go, or no-go with the blocking rows.

## Done when

- The release report under `${docs}` has every row linked to command output, the real-source trial output is attached, the checks above passed, and the verdict names the commit.

## Reply with

- The verdict, the blocking rows if any, the trial result, and the exit taken.
