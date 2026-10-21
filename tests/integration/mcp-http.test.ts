import { spawn } from "node:child_process";
import { request } from "node:http";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MAX_BODY_BYTES, startHttpServer, type HttpHandle } from "../../packages/mcp/src/http.ts";
import { tempDir, writeCustomers } from "../helpers/fixtures.ts";

const entry = join(import.meta.dirname, "../../packages/mcp/src/index.ts");
const TOKEN = "test-token-0123456789abcdef";

/** A raw request, so headers the client library would fix up can be set by hand. */
function raw(url: string, headers: Record<string, string>, body = "{}"): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = request(url, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...headers } }, (res) => {
      res.resume();
      resolve(res.statusCode ?? 0);
    });
    req.on("error", reject);
    req.end(body);
  });
}

describe("MCP adapter over HTTP", () => {
  const dir = tempDir();
  const file = join(dir, "customers.parquet");
  const outside = join(tempDir(), "outside.parquet");
  let handle: HttpHandle;

  const connect = async (token: string) => {
    const client = new Client({ name: "test", version: "0.0.0" });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(handle.url), { requestInit: { headers: { authorization: `Bearer ${token}` } } }),
    );
    return client;
  };

  beforeAll(async () => {
    await writeCustomers(file, 1000);
    await writeCustomers(outside, 10);
    handle = await startHttpServer({ roots: [dir], token: TOKEN });
  });

  afterAll(async () => {
    await handle.close();
  });

  it("serves the same tools, and card, ref and resolve run end to end with the token", async () => {
    const client = await connect(TOKEN);
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(["fusen_card", "fusen_peek", "fusen_ref", "fusen_resolve"]);

    const call = async (name: string, args: Record<string, unknown>) => {
      const result = await client.callTool({ name, arguments: args });
      return { isError: result.isError === true, text: (result.content as { text: string }[]).map((c) => c.text).join("\n") };
    };
    expect((await call("fusen_card", { path: file })).text).toContain("rows: 1000");
    const ref = (await call("fusen_ref", { path: file, where: "region = 'south'" })).text;
    const out = await call("fusen_resolve", { ref, limit: 1000 });
    expect(out.text.split("\n").filter((l) => l.startsWith("{"))).toHaveLength(250);
    expect((await call("fusen_peek", { path: outside })).isError).toBe(true);
    await client.close();
  });

  it("refuses a request without the token or with a wrong one", async () => {
    await expect(connect("wrong-token-0123456789abcdef")).rejects.toThrow();
    expect(await raw(handle.url, {})).toBe(401);
    expect(await raw(handle.url, { authorization: `Bearer ${TOKEN}x` })).toBe(401);
    expect(await raw(handle.url, { authorization: TOKEN })).toBe(401);
  });

  it("refuses a foreign Host header even with the token (DNS rebinding)", async () => {
    expect(await raw(handle.url, { authorization: `Bearer ${TOKEN}`, host: "evil.example:80" })).toBe(403);
  });

  it("refuses an oversized body and a body that is not JSON", async () => {
    const big = JSON.stringify({ pad: "x".repeat(MAX_BODY_BYTES) });
    expect(await raw(handle.url, { authorization: `Bearer ${TOKEN}` }, big)).toBe(413);
    expect(await raw(handle.url, { authorization: `Bearer ${TOKEN}` }, "{not json")).toBe(400);
  });

  it("refuses to bind a non-loopback address or to start with a short token", async () => {
    await expect(startHttpServer({ roots: [dir], token: TOKEN, host: "0.0.0.0" })).rejects.toThrow(/loopback/);
    await expect(startHttpServer({ roots: [dir], token: "short" })).rejects.toThrow(/at least/);
  });

  it("the entry point prints the URL and a generated token, and the token works", async () => {
    const env = { ...process.env };
    delete env.FUSEN_MCP_TOKEN;
    const child = spawn("node", [entry, "--http", "--port", "0", "--root", dir], { env, stdio: ["ignore", "ignore", "pipe"] });
    try {
      let stderr = "";
      await new Promise<void>((resolve, reject) => {
        child.stderr.on("data", (chunk: Buffer) => {
          stderr += chunk.toString();
          if (/token .*: \S+\n/.test(stderr)) resolve();
        });
        child.on("exit", () => reject(new Error(stderr)));
      });
      const url = /listening on (\S+)/.exec(stderr)![1]!;
      const token = /: (\S+)\n$/.exec(stderr)![1]!;
      const client = new Client({ name: "test", version: "0.0.0" });
      await client.connect(new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers: { authorization: `Bearer ${token}` } } }));
      expect((await client.listTools()).tools).toHaveLength(4);
      await client.close();
    } finally {
      child.kill();
    }
  });
});
