---
name: fusenduck-flow
description: The development workflow for building an open-source, agent-ready data reference tool (CLI, MCP server, Web UI, editor extension) on DuckDB: spike what is unknown, decide in an ADR, grow a tracer bullet test-first, manage contracts by expand-then-contract, add data sources up a stand-in ladder, review security, harden, and release behind human gates. Only use when the user invokes fusenduck-flow by name.
compatibility: Requires Node.js 18+ for scripts/flow.mjs.
---

# fusenduck-flow

This workflow encodes how a solo maintainer builds a quality open-source tool whose core idea (the Ref, the protocol, the data card) is still unproven: probe the unknowns with throwaway spikes, record the decision, then rebuild as a kept tracer bullet and grow it test-first. Contracts that other people and agents depend on change only by expand-then-contract, read-only safety is proven against hostile input, every change lands through a reviewed pull request, and nothing is published or run against a real source without the user's approval. The agent runs on its own between gates and stops only at them.

Read [principles.md](principles.md) once at the start of a task.

## How to run

This workflow runs on rails. `flow` below means `node scripts/flow.mjs` from this skill's directory, run with the project root as the working directory; it holds the state of the run and refuses moves the graph does not allow. Run `flow status` whenever you are unsure where you are.

A `${...}` in a playbook is a project binding: a command, path or other value this repository sets in `.flow/fusenduck-flow/project.md`. `flow status` shows the values the active playbook uses. If `flow` says a binding is unbound, ask the user to fill it in; never guess a value.

1. Match the request to one playbook below and run `flow start <playbook> --request "<one line>"`. Read the playbook file.
2. Do its steps in order. After each, run `flow step <n> --evidence "<what shows it>"`, or `--skip "<reason>"`. Never drop a step silently.
3. At a `[human-gate]` step, run `flow step <n>`, present what the user must decide, and end your turn. Only the user can pass the gate.
4. When every step is recorded, run `flow finish --evidence "<what proves Done when>"`. It runs the playbook's checks and lists the open exits.
5. Take the exit whose condition holds: `flow exit <to> --because "<why>"`. The next playbook starts; follow-ups stay in the current run.
6. To stop mid-playbook, run `flow pause --note "<handoff>"` first.
7. Stop only at human gates. Do not report between playbooks; when the run ends, summarize what changed, the evidence, and anything the user must decide.

## Routing

| Request | Playbook |
|---|---|
| A fuzzy idea, or a technical question I cannot answer yet (DuckDB behavior, Parquet footer, Ref design, MCP shape) | [spike](playbooks/spike.md) |
| Decide whether to build on what a spike showed | [decide](playbooks/decide.md) |
| Build the first end-to-end skeleton after a go decision | [tracer-bullet](playbooks/tracer-bullet.md) |
| Build or extend behavior (command, tool, rendering, Web UI, extension) | [increment](playbooks/increment.md) |
| Add a kind of data source (file format, database) | [add-source](playbooks/add-source.md) |
| Change the Ref, protocol, MCP tool shape or data card layout | [contract-change](playbooks/contract-change.md) |
| Check read-only safety, secrets, PII, prompt injection | [security-review](playbooks/security-review.md) |
| Raise kept code to release quality | [harden](playbooks/harden.md) |
| Decide whether a release candidate is ready | [release-gate](playbooks/release-gate.md) |
| Publish a release | [release](playbooks/release.md) |
| Reported defect | [bug-fix](playbooks/bug-fix.md) |
| Restructure without changing behavior | [refactor](playbooks/refactor.md) |
| Question about the code, data, design or a decision | [investigation](playbooks/investigation.md) |
| Look back, or the workflow feels wrong | [retro](playbooks/retro.md) |
| Nothing above fits | Pick the closest playbook, say which and why, or ask one question |

## Phases

| Lifecycle | Means | Leaves through |
|---|---|---|
| throwaway | Spikes built to learn; deleted afterwards | [decide](playbooks/decide.md) |
| tracer | Kept and grown in the real codebase | [release-gate](playbooks/release-gate.md) |
| hardened | Released; others depend on it | - |

See [graph.md](graph.md) for the full workflow graph and [profile.md](profile.md) for the choices behind it.
