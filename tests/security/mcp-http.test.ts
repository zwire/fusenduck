import { spawn } from "node:child_process";
import { request } from "node:http";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startHttpServer, type HttpHandle } from "../../packages/mcp/src/http.ts";
import { tempDir, writeCustomers } from "../helpers/fixtures.ts";

const entry = join(import.meta.dirname, "../../packages/mcp/src/index.ts");
const TOKEN = "test-token-0123456789abcdef";
const INIT = JSON.stringify({
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "0" } },
});

function status(url: string, headers: Record<string, string>): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = request(
      url,
      { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...headers } },
      (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      },
    );
    req.on("error", reject);
    req.end(INIT);
  });
}

describe("MCP over HTTP: browser origins", () => {
  const dir = tempDir();
  let handle: HttpHandle;

  beforeAll(async () => {
    await writeCustomers(join(dir, "customers.parquet"), 10);
    handle = await startHttpServer({ roots: [dir], token: TOKEN });
  });
  afterAll(() => handle.close());

  it("refuses a request from a foreign web origin even with the token", async () => {
    const auth = { authorization: `Bearer ${TOKEN}` };
    expect(await status(handle.url, { ...auth, origin: "http://evil.example" })).toBe(403);
    expect(await status(handle.url, { ...auth, origin: "null" })).toBe(403);
  });

  it("accepts no Origin (a non-browser client) and the server's own loopback origin", async () => {
    const auth = { authorization: `Bearer ${TOKEN}` };
    const port = new URL(handle.url).port;
    expect(await status(handle.url, auth)).toBe(200);
    for (const origin of [`http://127.0.0.1:${port}`, `http://localhost:${port}`, `http://[::1]:${port}`]) {
      expect(await status(handle.url, { ...auth, origin })).toBe(200);
    }
  });
});

describe("a canary token never leaves the process", () => {
  const CANARY = "CANARY-6f1d0c9e-token-do-not-leak";
  const dir = tempDir();
  const file = join(dir, "customers.parquet");
  const outside = join(tempDir(), "outside.parquet");

  beforeAll(async () => {
    await writeCustomers(file, 50);
    await writeCustomers(outside, 5);
  });

  it("is in no tool output, error message or log line, across every tool and its failures", async () => {
    const child = spawn("node", [entry, "--http", "--port", "0", "--root", dir], {
      env: { ...process.env, FUSEN_MCP_TOKEN: CANARY, DEBUG: "*" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let logs = "";
    child.stdout.on("data", (chunk: Buffer) => (logs += chunk.toString()));
    child.stderr.on("data", (chunk: Buffer) => (logs += chunk.toString()));
    try {
      await new Promise<void>((resolve, reject) => {
        child.stderr.on("data", () => /listening on \S+\n/.test(logs) && resolve());
        child.on("exit", () => reject(new Error(logs)));
      });
      const url = /listening on (\S+)/.exec(logs)![1]!;
      const client = new Client({ name: "test", version: "0.0.0" });
      await client.connect(new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers: { authorization: `Bearer ${CANARY}` } } }));
      const outputs: string[] = [];
      const call = async (name: string, args: Record<string, unknown>) => {
        const result = await client.callTool({ name, arguments: args });
        const text = (result.content as { text: string }[]).map((c) => c.text).join("\n");
        outputs.push(text);
        return text;
      };
      await call("fusen_card", { path: file });
      await call("fusen_peek", { path: file });
      const ref = await call("fusen_ref", { path: file, where: "id < 3" });
      await call("fusen_resolve", { ref });
      // Failures: outside the root, a rejected predicate, an engine error, a malformed Ref.
      await call("fusen_card", { path: outside });
      await call("fusen_ref", { path: file, where: "1=1; DROP TABLE t" });
      await call("fusen_ref", { path: file, where: "CAST(note AS INTEGER) > 0" });
      await call("fusen_resolve", { ref: "fusen://file/%2Fnope?v=1" });
      await client.close();
      // A refused request is logged nowhere with its token either.
      await status(url, { authorization: `Bearer ${CANARY}x` });
      await status(url, { authorization: `Bearer ${CANARY}`, host: "evil.example" });

      expect(outputs.some((o) => o.includes("fusen error"))).toBe(true);
      for (const text of [...outputs, logs]) expect(text).not.toContain(CANARY);
    } finally {
      child.kill();
    }
  });
});
