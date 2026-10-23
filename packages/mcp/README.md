# @fusenduck/mcp

The MCP server `fusen-mcp`. It is not published yet, so run it from the repository with `node packages/mcp/src/index.ts`.

```
fusen-mcp [--root <dir>]... [--http [--host <loopback>] [--port <n>]]
fusen-mcp --help
```

A command-line mistake exits with 2, and a server that could not start (port already in use, for example) exits with 1.

## Tools

The argument types and ranges are listed in [docs/reference/mcp-tools.md](../../docs/reference/mcp-tools.md), generated from the schemas.

| Tool | Arguments | What it does |
| --- | --- | --- |
| `fusen_card` | `path` | The data card. No row values are returned |
| `fusen_peek` | `path`, `rows?` (0–50, default 5) | The card, the first rows and a Ref for the whole file |
| `fusen_ref` | `path`, `query?`, `where?`, `columns?` | A `fusen://` Ref that stands for the selection |
| `fusen_resolve` | `ref`, `limit?` (0–1000, default 100) | The rows of a Ref. `DATA_CHANGED` if the data changed |

Only files under `--root` can be read (default: the current directory; repeatable). Tool descriptions are fixed, and data appears only between the delimiters of a tool result. Engine error messages are withheld, and standard error gets only the error kind and the stack lines (the full text, which can contain cell values, only with `FUSEN_DEBUG=1`).

## stdio

```sh
node packages/mcp/src/index.ts --root /path/to/data
```

## HTTP (Streamable HTTP)

```sh
FUSEN_MCP_TOKEN=<at least 16 characters> node packages/mcp/src/index.ts --http --port 7457 --root /path/to/data
# → http://127.0.0.1:7457/mcp
```

- It listens on loopback only (`127.0.0.1`, `::1`, `localhost`). The default is `127.0.0.1:7457`.
- Every request needs `Authorization: Bearer <token>`. Without `FUSEN_MCP_TOKEN`, one is generated at startup and printed on standard error.
- The `Host` header is checked too, which prevents DNS rebinding.

See [docs/guide.md](../../docs/guide.md) for more.
