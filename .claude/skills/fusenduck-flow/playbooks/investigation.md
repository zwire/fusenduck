---
id: investigation
title: Investigation
phase: any
lifecycle: any
kind: service
writes: []
exits:
  - to: end
    when: the answer cites evidence for each claim
  - to: spike
    when: the answer shows an open problem worth exploring
---

# Investigation

## Purpose

Answer a read-only question about the code, a decision, the contract, or a dataset behavior, with evidence.

## Steps

1. Restate the question and what a useful answer looks like.
2. Read the relevant code, the decision records under `${adr}`, the docs under `${docs}`, and the git history; run only read-only commands (searching, listing, read-only DuckDB queries against `${fixtures}`).
3. Answer with references: file and line, decision record, pasted command output. Mark each inference as an inference.

## Done when

- Every claim in the answer cites a file and line, a decision record or pasted command output.

## Reply with

- The answer, the evidence, and whether an open problem should go to `spike`.
