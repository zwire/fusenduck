---
id: spike
title: Spike
phase: explore
lifecycle: throwaway
kind: work
writes: [${scratch}/**]
exits:
  - to: decide
    when: the learning log states an answer, with pasted output, that changes what gets built
  - to: spike
    when: the spike showed the question was wrong or too wide, and a narrower question replaces it
  - to: end
    when: the answer is a clear no-go, recorded in the learning log
---

# Spike

## Purpose

Answer one question that decides what to build (a DuckDB behavior, what the Parquet footer exposes, whether a Ref form survives use by an agent, how an MCP tool shape reads). The output is knowledge in a learning log, not code.

## Parameters

- Timebox: 1 to 3 sessions per question.
- Variants: up to 3 in parallel, only when two or more approaches are viable.
- Scratch location: `${scratch}`.

## Steps

1. Write the question as "if I knew X, I would build Y" and the timebox at the top of `${scratch}/<question>/LOG.md`, and name the observation that answers it (a query result, a measured size or time, a failing call).
2. List the viable approaches. For two or more, give each its own folder `${scratch}/<question>/<variant>` and run each in its own agent in parallel; for one, run it directly.
3. Probe with the least code that yields the observation: DuckDB through its Node API, the Parquet footer through `parquet_metadata()` and `parquet_schema()`, an MCP server stub on the official SDK, or a Ref parse sketch. No tests, abstractions or cleanup.
4. Record each attempt in `LOG.md` as tried, observed (paste the real output) and concluded. For size or speed questions record the number and the size of the input it was measured on.
5. Compare variants against the same observation in one context. Stop at the answer or at the timebox.
6. Label the scratch code throwaway in `LOG.md` and list the shortcuts it took, so `decide` can refuse to copy them.

## Done when

- `${scratch}/<question>/LOG.md` states the answer, or "unknown after timebox", with pasted command output and measured numbers, and no file outside `${scratch}` changed.

## Reply with

- The question, the answer in one line, the evidence location, and which exit applies.
