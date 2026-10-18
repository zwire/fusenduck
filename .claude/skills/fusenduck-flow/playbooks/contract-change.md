---
id: contract-change
title: Contract change
phase: expand
lifecycle: tracer
kind: work
writes: [${contract}, ${code}, ${config}, ${fixtures}/**, ${docs}]
checks:
  - ${typecheck}
  - ${lint}
  - ${test}
  - ${contract-check}
exits:
  - to: increment
    when: consumers use the new shape and old Refs still resolve
    on: pass
  - to: end
    when: the change is merged and nothing else is queued
    on: pass
---

# Contract change

## Purpose

Change a shape that other code and other agents depend on (Ref grammar, protocol message, MCP tool input or output, data card layout, rendering levels) by expand-then-contract, so nothing that worked yesterday breaks without notice.

## Parameters

- Stability: pre-1.0, breaking changes allowed only through this playbook and recorded in a changeset.
- Deprecation window: the old shape stays until the earliest release named in the changeset.

## Steps

1. Name the contract, its consumers (CLI, MCP adapter, Web UI, editor extension, agents holding stored Refs), and classify the change as additive, behavior-changing or removal.
2. Expand: write failing contract tests first (schema validation and golden renderings), keep the red output, then add the new shape beside the old one.
3. Store every Ref the old shape minted in `${refs-corpus}` and run `${contract-check}`; keep its schema diff against the last released contract.
4. Migrate the consumers in the same change and run `${test}`.
5. Record the change with `${changeset}`: bump level, deprecation notice, and the earliest release that may remove the old shape.
6. [human-gate] For a removal only: the user confirms the deprecation window has passed and no supported consumer still uses the old shape.
7. After that approval, remove the old shape in a separate pull request and run `${contract-check}` again.
8. Land the change ([Land through a pull request](../principles.md#land-through-a-pull-request)).

## Done when

- The `${contract-check}` schema diff lists exactly the intended change, new tests show red then green, old Refs in `${refs-corpus}` still resolve, the changeset states the bump and the removal date, and any removal happened only after the user's approval.

## Reply with

- The contract changed, the schema diff, the consumers migrated, and the planned removal release.
