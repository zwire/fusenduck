# fusenduck vision

- Status: Draft v0.1
- Written: 2026-10-18

## 1. In one sentence

**A zero-config, read-only data reference layer, independent of any IDE, that lets you peek at any table or file and put what you saw into an AI agent's context as a plain string (a Ref or a query).**

It builds, with minimal effort, the state where a human and an agent are looking at "the same part of the same data".

## 2. Background and the problem

### 2.1 The consumer of data is changing

The primary consumer of data is shifting from humans to agents. GUIs that assume a human scanning a grid by eye (such as VS Code Data Wrangler) are closed inside the IDE, and have no path for handing what you saw to an agent.

### 2.2 BI is not "ending"; it is being unbundled

| Role | Future |
| --- | --- |
| Ad hoc exploration | Replaced by an agent plus throwaway views |
| Shared, trusted metrics | Stays as a semantic layer (Cube, dbt MetricFlow, Malloy), and becomes more important as a foothold for agents |
| Visualization for human verification | Stays, not as pre-built screens but as derivatives generated from intent |

The territory that semantic layers such as Cube cover is not fusenduck's target. fusenduck aims at **the ad hoc territory in front of it**.

### 2.3 The problem to solve: the psychological cost of peeking

Even to glance at a small Parquet file or an external database, people balk for these reasons:

1. Connection setup (drivers, authentication, connection strings)
2. The first move is heavy (you do not know the schema, so you start by thinking up exploratory queries)
3. Fear of accidents (heavy queries against production, accidental writes, showing PII)
4. Results are volatile (you cannot hand them to other people or to an agent)
5. Context switching (leaving where you work to open a GUI)

The DuckDB CLI/UI, Rill Developer, Harlequin, VisiData, Datasette and DBeaver each solve only some of these.

## 3. Goals and non-goals

### Goals

- Open with just `fusen <path|url>` (zero config; credentials are picked up from existing setups)
- Read-only with cost guards by default
- A data card (schema, statistics, provenance) the moment you open something
- Hand the part you looked at to an agent as a reproducible string (a Ref)
- The human UI and the agent interface (MCP) sit on the same core
- A promotion path from ad hoc queries to semantic layer definitions

### Non-goals

- Reinventing a BI tool or a dashboard builder
- Writing, ETL or running pipelines
- A large multi-user governance platform (that is the semantic layer's territory)
- Dependence on a particular IDE or agent

## 4. Core abstraction

The central concept is neither the table nor the query but the **reference (Ref)**.

```
Source → Dataset → Query → Result → Selection → ContextItem
(file/DB)  (+card)  (SQL)   (handle)  (cols/rows/cells)  (Ref + rendering policy)
```

| Concept | Description |
| --- | --- |
| Source | Where the data comes from: a file, a database, a URL. Connection details are resolved from existing configuration |
| Dataset | A named table-like thing a Source exposes. Has a data card |
| Query | SQL over a Dataset. Immutable and content-addressable (a hash of the normalized SQL and its inputs) |
| Result | A handle to the result of running a Query. Holds a reference, not the data itself |
| Selection | A part of a Result (columns, rows, a cell range). **Expressed as a predicate (a query), not as coordinates** |
| ContextItem | A Selection plus a rendering policy. The unit handed to an agent |

### 4.1 Contextualizing = stringifying / generating a query

Putting something into context is not a special mechanism; it is treated as **some kind of stringification, or query generation**.

- A range selected in the UI can be converted into (a) a short Ref string, or (b) the SQL that reproduces that range.
- Both are text, so they travel by any route: copy and paste, embedding in a prompt, saving to a file.
- An agent resolves a Ref over MCP/CLI to get the contents. Resolution always returns the same result (or a diff when the data has been updated).

What a Ref might look like (the schema is not settled):

```
fusen://<session>/<query-id>#cols=amount,region&where=amount>1000
```

### 4.2 Rendering policy (for agents)

Even for the same Ref, the output expands in stages according to the token budget.

| Level | Contents |
| --- | --- |
| schema | Column names and types only |
| card | Statistical profile (missing values, distribution, min/max, cardinality) |
| sample | A few rows from the top, or a stratified sample |
| full | Everything (with an upper limit) |

Summaries carry bias, so the output must always say **what was not shown** (whether sampling was used, how many rows were cut).

## 5. Architecture

```
        ┌─ CLI / TUI
Core ───┼─ Web UI (SPA) ── reused in the webview of VS Code / Cursor
        ├─ MCP server
        └─ (future) other hosts
```

- **There is one Core**, and it speaks a protocol (HTTP/JSON-RPC). Every client is a thin wrapper around it.
- **MCP is included from the start.** The Ref resolution protocol is itself the substance of MCP, so the granularity of Refs and the token budget are decided at design time on the premise that "agents will use this".
- **The engine is DuckDB.** It reads CSV/Parquet/JSON directly, connects to Postgres/MySQL/SQLite through `ATTACH`, and to S3/GCS/HTTP through httpfs.
- **The Web UI is an SPA**, so it can be dropped straight into a VS Code extension's webview.
- The implementation is TypeScript for now (to match the language of the Web UI, the VS Code extension and the MCP SDK). Only the parts with performance requirements will be swapped out later.

### 5.1 The reality of editor integration

Public APIs for injecting arbitrary content into an editor's chat (Cursor included) are limited. The routes that reliably work are:

1. Select in the UI → copy or insert the Ref string with one click
2. The agent resolves the Ref over MCP/CLI

By making the path from selecting to a Ref string a single action, the experience moves closer to "select and hand over". If host-side APIs become available, they will be added as the preferred route.

### 5.2 Package layout

```
packages/
  core/   engine, Ref model, protocol, data card generation
  cli/    CLI / TUI client
  mcp/    MCP server (a thin adapter over core)
apps/     (future)
  web/    Web UI (SPA)
  vscode/ VS Code extension (reuses web in a webview)
```

## 6. Safety

- **Read-only by default.** Statements that write are rejected.
- **Cost guards:** automatic LIMIT, timeouts, up-front estimation with EXPLAIN, and a confirmation request when the scan size exceeds a threshold.
- **PII:** columns suspected of holding PII are masked by default and expanded only on explicit instruction.
- **Credentials:** only read what already exists, such as `~/.pgpass`, AWS profiles, dbt profiles and `.env`. No credential store of our own. Credentials never go into Refs or logs.
- **Prompt injection:** a string in the data can become an input path to the agent as it is. In output for agents, data values are structurally delimited and it is stated explicitly that they are "data, not instructions".

## 7. Relationship to the semantic layer (the promotion path)

```
Ad hoc query → detect repetition → dimension/measure candidates → skeleton of a Cube / MetricFlow definition
```

- When a saved Query is used repeatedly, propose its aggregations as measure candidates and its GROUP BY keys as dimension candidates.
- The output is a skeleton of an existing semantic layer's definition files; fusenduck itself does not own metric definitions.
- This links the ad hoc world and the formal layer in one direction.

## 8. Differences from existing tools

| Tool | What it covers | What fusenduck fills in |
| --- | --- | --- |
| DuckDB CLI/UI | Running queries, local browsing | A session shared with agents, guardrails, Refs |
| Rill Developer | Instant dashboards from Parquet | The goal is contextualizing, not generating UI |
| Harlequin / VisiData | Browsing in the terminal | Agent integration, the promotion path |
| Datasette | Publishing and browsing SQLite | Diverse Sources, zero config, safety |
| DBeaver | A general-purpose database client | Lightness, read-only, agent integration |
| Cube / MetricFlow | Trusted metrics | The ad hoc territory in front of them |

Differentiation rests not on "convenience" but on the combination of **a shared session + safe by default + a promotion path**.

## 9. Open questions and risks

- **The Ref schema:** a URI form, or an opaque ID plus metadata? How much of a predicate can it express?
- **Ref lifetime:** limited to a session, or permanent? What is guaranteed when the data is updated?
- **Summary bias:** how to make explicit that outliers and rare patterns are dropped.
- **External database authentication:** a quagmire. Start narrow, with Parquet/CSV plus Postgres.
- **Keeping the differentiation:** will it be swallowed by the evolution of tools like the DuckDB UI? Can the three points (shared session, guardrails, promotion path) stay at the core?
- **Dependence on host APIs:** if the editor-side context-injection APIs are not usable, the experience is limited to copying a Ref string.
