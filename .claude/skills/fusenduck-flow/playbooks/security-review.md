---
id: security-review
title: Security review
phase: expand
lifecycle: tracer
kind: work
writes: [${code}, ${fixtures}/**, ${docs}]
checks:
  - ${security-test}
  - ${test}
exits:
  - to: release-gate
    when: the candidate commit has a clean report and is ready for the release gate
    on: pass
  - to: end
    when: the review ran mid-development, everything found is fixed and merged
    on: pass
  - to: harden
    when: a finding needs structural work, not a local fix
    on: fail
---

# Security review

## Purpose

Prove, against hostile input, that the tool is read-only by construction, leaks no secret, masks PII by default, and cannot be turned against the agent that reads its output. The result is a report tied to a commit that `release-gate` requires.

## Parameters

- Surfaces: SQL text from users and agents, paths and URLs, connection strings and credential sources, data values in results, Ref strings, MCP tool inputs.
- Report: written under `${docs}` and named by commit.

## Steps

1. List the surfaces in play for this commit and the adversarial case each one needs.
2. Write failing tests first for each surface and keep the red output: statements that write or escape (`INSERT`, `UPDATE`, `DELETE`, `COPY ... TO`, `ATTACH` of a new database file, `INSTALL` and `LOAD`, `EXPORT DATABASE`), multi-statement and comment-smuggled SQL, file functions outside the allowed directories, outbound HTTP, and path traversal inside Refs.
3. Show that read-only is enforced by the engine and the credentials (read-only attach, allowed directories, external access off, locked configuration, a read-only role), not by string matching, and keep the output.
4. Plant a canary secret in the environment and in a connection string, run every command with verbose logging, and show it appears in no Ref, log line, error message, tool output or saved session file.
5. Check PII handling: columns with PII-like names and values shaped like email addresses or phone numbers are masked in samples by default, and unmasking needs an explicit option.
6. Check prompt-injection handling: fixture rows containing instructions, fake tool calls, markdown and HTML appear only inside the delimited data block of agent-facing output, never in tool descriptions, and the output says the block is data.
7. Check resource abuse: a runaway query, a huge result and a deeply nested Ref hit the timeout, the row and byte caps and the "not shown" note.
8. Fix each failure at its root, then write the report: what was tested, what failed, what was fixed, what remains.
9. Land the change ([Land through a pull request](../principles.md#land-through-a-pull-request)).

## Done when

- `${security-test}` has a test per surface, each shown failing before its fix where a fix was needed, the canary test is green, the report for this commit exists under `${docs}`, and the pull request is merged after independent review.

## Reply with

- The surfaces covered, the findings and fixes, the report location, and the exit taken.
