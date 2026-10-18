---
id: decide
title: Decide
phase: explore
lifecycle: any
kind: gate
promotes: throwaway->tracer
writes: [${adr}/**]
exits:
  - to: tracer-bullet
    when: the verdict is go and no end-to-end skeleton exists yet
  - to: increment
    when: the verdict is go and the end-to-end skeleton already exists
  - to: spike
    when: the verdict is explore further
  - to: end
    when: the verdict is no-go
---

# Decide

## Purpose

Promotion gate from `throwaway` to `tracer`. Turn what the spikes learned into an architecture decision record the project keeps, and block spike code from becoming product code.

## Parameters

- Approver: the user.
- Record location: `${adr}`.

## Steps

1. Summarize each learning log: question, answer, pasted evidence, and the shortcuts the spike took.
2. Check the promotion criteria: the answer is backed by observed output, it justifies building (value or feasibility shown), and the shortcuts are listed.
3. Write the decision record in `${adr}`: context, decision, consequences, alternatives rejected with the reason, and the evidence links. When the decision fixes a contract (Ref grammar, protocol message, MCP tool shape, data card layout), name it and its stability level.
4. Name the first slice with its acceptance test, and the budgets it must respect (context tokens per rendering level, bytes and rows read to build a card).
5. [human-gate] The user approves the verdict (go, explore further, or no-go) and the decision record.
6. On go, state in the record that spike code stays in `${scratch}` and is not imported; the tracer is written fresh in the real structure.

## Done when

- A decision record exists in `${adr}` with the verdict, links to the learning logs, the first slice with its acceptance test, and the user's approval recorded by the runtime.

## Reply with

- The verdict, the record location, the first slice, and the exit taken.
