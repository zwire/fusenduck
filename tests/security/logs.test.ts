import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { DuckDBInstance } from "@duckdb/node-api";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { lit } from "../../packages/core/src/engine.ts";
import { startWebServer, type WebHandle } from "../../apps/web/src/server.ts";
import { Host } from "../../apps/vscode/src/host.ts";
import { tempDir } from "../helpers/fixtures.ts";
import { buildSpa, call } from "../helpers/web.ts";

// Engine errors can quote cell values ("Could not convert string 'alice@example.com' to INT32").
// Callers get a fixed message; the servers' own logs (stderr, which MCP hosts keep in log files, and
// the VS Code Output panel) must not carry the value either, unless FUSEN_DEBUG=1 asks for it.

const CELL = "CANARY-CELL-3b9e1f";
// A filter that passes planning and fails on the first row, quoting its value.
const FAILS = "CAST(secret AS INTEGER) > 0";

async function writeSecret(path: string): Promise<void> {
  const connection = await (await DuckDBInstance.create(":memory:")).connect();
  await connection.run(`COPY (SELECT 1 AS id, '${CELL}' AS secret) TO ${lit(path)} (FORMAT parquet)`);
}

describe("an engine error that quotes a cell is not written to a log", () => {
  const dir = tempDir();
  const file = join(dir, "secret.parquet");

  beforeAll(async () => {
    buildSpa();
    await writeSecret(file);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  const logged = () => {
    const lines: string[] = [];
    vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => void lines.push(args.map((a) => (a instanceof Error ? (a.stack ?? a.message) : String(a))).join(" ")));
    return lines;
  };

  describe("the Web UI server", () => {
    let handle: WebHandle;
    let base: string;
    let token: string;

    beforeAll(async () => {
      handle = await startWebServer({ roots: [dir] });
      base = new URL(handle.url).origin;
      const code = new URL(handle.url).hash.replace("#c=", "");
      token = String((await call(base, "/api/session", { code })).body.token);
    });

    afterAll(async () => {
      await handle.close();
    });

    const rows = async () => {
      const opened = await call(base, "/api/open", { path: file }, { token });
      const { source, fingerprint } = opened.body as { source: string; fingerprint: string };
      return call(base, "/api/rows", { source, fingerprint, offset: 0, limit: 10, where: FAILS }, { token });
    };

    it("logs the kind of error and where it came from, not the value", async () => {
      const lines = logged();
      const res = await rows();
      expect(res.status).toBe(500);
      expect(JSON.stringify(res.body)).not.toContain(CELL);
      expect(lines.join("\n")).toMatch(/Conversion Error/);
      expect(lines.join("\n")).toMatch(/FUSEN_DEBUG=1/);
      expect(lines.join("\n")).not.toContain(CELL);
    });

    it("logs the whole message with FUSEN_DEBUG=1", async () => {
      vi.stubEnv("FUSEN_DEBUG", "1");
      const lines = logged();
      await rows();
      expect(lines.join("\n")).toContain(CELL);
    });
  });

  it("the VS Code extension host", async () => {
    const lines: string[] = [];
    const host = new Host({ path: file, roots: [dir], copy: async () => undefined, log: (line) => void lines.push(line) });
    try {
      const opened = (await host.handle({ id: 1, method: "open", params: { path: file } })) as { result: { source: string; fingerprint: string } };
      const { source, fingerprint } = opened.result;
      const reply = await host.handle({ id: 2, method: "rows", params: { source, fingerprint, offset: 0, limit: 10, where: FAILS } });
      expect(JSON.stringify(reply)).not.toContain(CELL);
      expect(lines.join("\n")).toMatch(/Conversion Error/);
      expect(lines.join("\n")).not.toContain(CELL);
    } finally {
      await host.close();
    }
  });

  it("the MCP server over stdio (its stderr goes to the host's log files)", async () => {
    const transport = new StdioClientTransport({
      command: "node",
      args: [join(import.meta.dirname, "../../packages/mcp/src/index.ts"), "--root", dir],
      env: { ...process.env, FUSEN_DEBUG: "" } as Record<string, string>,
      stderr: "pipe",
    });
    let stderr = "";
    transport.stderr?.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
    const client = new Client({ name: "test", version: "0.0.0" });
    await client.connect(transport);
    try {
      const result = await client.callTool({ name: "fusen_ref", arguments: { path: file, where: FAILS } });
      const ref = (result.content as { text: string }[])[0]!.text;
      // Minting plans the predicate only; resolving reads the row and fails on it.
      const resolved = await client.callTool({ name: "fusen_resolve", arguments: { ref } });
      expect(resolved.isError).toBe(true);
      expect(JSON.stringify(resolved.content)).not.toContain(CELL);
    } finally {
      await client.close();
    }
    expect(stderr).toMatch(/Conversion Error/);
    expect(stderr).not.toContain(CELL);
  });
});
