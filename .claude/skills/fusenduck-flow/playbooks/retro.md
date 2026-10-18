---
id: retro
title: Retro
phase: any
lifecycle: any
kind: work
writes: [${docs}]
exits:
  - to: end
    when: the changes are recorded and the workflow is updated or explicitly kept
---

# Retro

## Purpose

Turn experience into structural change, including changes to this workflow, and notice when the project has changed phase.

## Steps

1. Collect what went well, what hurt and what surprised since the last retro, from the run log (`flow log`), merged pull requests and reported issues.
2. For each pain, find where it entered the workflow: which playbook, which step, which check.
3. Propose at most three changes. Prefer changing a step, a check or a gate over adding a rule.
4. Check the phase signals: has the Ref survived real use by agents, and do people use the tool without being asked (explore to expand)? Is the contract stable and has work shifted to keeping it fast, safe and compatible (expand to extract)? Have external users or reports appeared that call for an incident playbook?
5. If the workflow should change, run vajra in Evolve mode; write the decision either way in the retro note under `${docs}`.

## Done when

- A retro note under `${docs}` lists the pains, the at most three changes, the phase signals checked, and whether the workflow was updated or kept.

## Reply with

- The changes proposed, the phase signals, and whether to run Evolve.
