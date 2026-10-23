import { createHash, timingSafeEqual } from "node:crypto";
import { createServer as createHttpServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { logLine } from "@fusenduck/core";
import { Gate } from "./gate.ts";
import { createServer } from "./server.ts";

// MCP over Streamable HTTP, stateless: each POST gets its own server and transport. The listener
// binds a loopback address only, and every request must carry the bearer token. The Host header is
// checked too, so a page that rebinds its DNS name to 127.0.0.1 cannot reach the server, and a
// browser request from any other web origin is refused (the MCP spec asks servers to check Origin).

/** Hosts the server may bind. Anything else would expose local files to the network. */
export const LOOPBACK_HOSTS = ["127.0.0.1", "::1", "localhost"] as const;
/** Largest request body accepted, in bytes. Tool arguments are short strings. */
export const MAX_BODY_BYTES = 1024 * 1024;
/** Shortest token accepted, so a guessable one is refused at startup. */
export const MIN_TOKEN_LENGTH = 16;
/** Tool calls that run at once. Each opens an engine of up to 512MB (peek opens two). */
export const MAX_CONCURRENT = 4;
/** Tool calls that wait for a slot; past this a call is refused as busy. */
export const MAX_QUEUED = 16;

export interface HttpOptions {
  roots: string[];
  token: string;
  host?: string;
  port?: number;
  maxConcurrent?: number;
  maxQueued?: number;
}

export interface HttpHandle {
  url: string;
  close(): Promise<void>;
}

const digest = (value: string) => createHash("sha256").update(value).digest();

function reply(res: ServerResponse, status: number, message: string, headers: Record<string, string> = {}): void {
  res.writeHead(status, { "content-type": "application/json", ...headers });
  res.end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32000, message }, id: null }));
}

class BodyTooLarge extends Error {}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY_BYTES) throw new BodyTooLarge();
    chunks.push(chunk as Buffer);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

/** Serve the MCP tools over HTTP on a loopback address. Files are readable only under `roots`. */
export async function startHttpServer(options: HttpOptions): Promise<HttpHandle> {
  const host = options.host ?? "127.0.0.1";
  if (!(LOOPBACK_HOSTS as readonly string[]).includes(host)) {
    throw new Error(`--host must be a loopback address (${LOOPBACK_HOSTS.join(", ")}), got ${host}`);
  }
  if (options.token.length < MIN_TOKEN_LENGTH) {
    throw new Error(`the token must be at least ${MIN_TOKEN_LENGTH} characters`);
  }
  const expected = digest(options.token);
  const gate = new Gate(options.maxConcurrent ?? MAX_CONCURRENT, options.maxQueued ?? MAX_QUEUED);
  let allowedHosts: string[] = [];
  let allowedOrigins: string[] = [];

  const http = createHttpServer(async (req, res) => {
    if (!allowedHosts.includes(req.headers.host ?? "")) return reply(res, 403, "Forbidden host");
    const origin = req.headers.origin;
    if (origin !== undefined && !allowedOrigins.includes(origin)) return reply(res, 403, "Forbidden origin");
    // The auth scheme is case-insensitive (RFC 9110); the token is not.
    const token = /^Bearer\s+(.+)$/i.exec(req.headers.authorization ?? "")?.[1] ?? "";
    if (!timingSafeEqual(digest(token), expected)) {
      return reply(res, 401, "Unauthorized", { "www-authenticate": "Bearer" });
    }
    if (new URL(req.url ?? "/", "http://localhost").pathname !== "/mcp") return reply(res, 404, "Not found");
    if (req.method !== "POST") return reply(res, 405, "Method not allowed", { allow: "POST" });
    let body: unknown;
    try {
      body = await readJson(req);
    } catch (error) {
      return error instanceof BodyTooLarge ? reply(res, 413, "Request body too large") : reply(res, 400, "Invalid JSON");
    }
    const server = createServer(options.roots, gate);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    // A client that hangs up closes the transport, which cancels its tool call and stops the query.
    res.on("close", () => {
      void transport.close();
      void server.close();
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, body);
    } catch (error) {
      console.error(logLine(error));
      if (!res.headersSent) reply(res, 500, "Internal server error");
    }
  });

  // A slow body holds a connection; tool arguments arrive in well under this.
  http.requestTimeout = 30_000;
  await new Promise<void>((resolve, reject) => {
    http.once("error", reject);
    http.listen(options.port ?? 0, host, () => resolve());
  });
  const { port } = http.address() as AddressInfo;
  allowedHosts = [`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`];
  allowedOrigins = allowedHosts.map((h) => `http://${h}`);
  const hostPart = host === "::1" ? "[::1]" : host;
  return {
    url: `http://${hostPart}:${port}/mcp`,
    close: () => new Promise<void>((resolve, reject) => http.close((error) => (error ? reject(error) : resolve()))),
  };
}
