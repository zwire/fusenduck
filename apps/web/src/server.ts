import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { describeError, FusenError, logLine, SourceChanged } from "@fusenduck/core";
import { listFiles } from "./files.ts";
import { View } from "./view.ts";

// The local server of the Web UI (docs/adr/0002): it serves the SPA and a small JSON API on one
// loopback origin. The URL it prints carries a one-time code in its fragment; the SPA trades the code
// for the session token, which every API call sends as a bearer token. Every request must name the
// server itself in Host (DNS rebinding) and, if it has one, in Origin. API calls must be JSON, so a
// page elsewhere cannot send one without a CORS preflight, which this server never answers.

/** Hosts the server may bind. Anything else would expose local files to the network. */
export const LOOPBACK_HOSTS = ["127.0.0.1", "::1", "localhost"] as const;
/** How long the code in the printed URL can be traded for the token. */
export const CODE_TTL_MS = 60_000;
/** Largest request body accepted, in bytes. A selection of 1,000 ranges is well under this. */
export const MAX_BODY_BYTES = 64 * 1024;

export const CSP =
  "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; " +
  "frame-ancestors 'none'; base-uri 'none'; form-action 'none'; require-trusted-types-for 'script'";

const SECURITY_HEADERS = {
  "content-security-policy": CSP,
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "cache-control": "no-store",
};

export interface WebOptions {
  roots: string[];
  host?: string;
  port?: number;
  /** The clock, in milliseconds; tests move it to expire the code. */
  now?: () => number;
}

export interface WebHandle {
  /** The URL to open, with the one-time code in its fragment. */
  url: string;
  close(): Promise<void>;
}

const spa = join(import.meta.dirname, "../spa");
const dist = join(import.meta.dirname, "../dist");
const STATIC: Record<string, { file: string; type: string }> = {
  "/": { file: join(spa, "index.html"), type: "text/html; charset=utf-8" },
  "/style.css": { file: join(spa, "style.css"), type: "text/css; charset=utf-8" },
  "/app.js": { file: join(dist, "app.js"), type: "text/javascript; charset=utf-8" },
  "/api.js": { file: join(dist, "api.js"), type: "text/javascript; charset=utf-8" },
};

const digest = (value: string) => createHash("sha256").update(value).digest();
const same = (a: string, b: Buffer) => timingSafeEqual(digest(a), b);

class HttpError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

function send(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  res.writeHead(status, { ...SECURITY_HEADERS, "content-type": "application/json", ...headers });
  res.end(JSON.stringify(body));
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY_BYTES) throw new HttpError(413, "request body too large");
    chunks.push(chunk as Buffer);
  }
  let body: unknown;
  try {
    body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new HttpError(400, "invalid JSON");
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) throw new HttpError(400, "the body must be a JSON object");
  return body as Record<string, unknown>;
}

/** Serve the Web UI on a loopback address. Files are readable only under `roots`. */
export async function startWebServer(options: WebOptions): Promise<WebHandle> {
  const host = options.host ?? "127.0.0.1";
  if (!(LOOPBACK_HOSTS as readonly string[]).includes(host)) {
    throw new Error(`--host must be a loopback address (${LOOPBACK_HOSTS.join(", ")}), got ${host}`);
  }
  const now = options.now ?? Date.now;
  const files = Object.fromEntries(
    Object.entries(STATIC).map(([path, { file, type }]) => {
      try {
        return [path, { body: readFileSync(file), type }];
      } catch {
        throw new Error(`the Web UI is not built (missing ${file}): run pnpm build`);
      }
    }),
  );

  const code = randomBytes(32).toString("base64url");
  const token = randomBytes(32).toString("base64url");
  let codeDigest: Buffer | undefined = digest(code);
  const codeExpires = now() + CODE_TTL_MS;
  const tokenDigest = digest(token);
  let allowedHosts: string[] = [];
  let allowedOrigins: string[] = [];
  let view: View | undefined;

  async function api(req: IncomingMessage, path: string): Promise<unknown> {
    if (req.method !== "POST") throw new HttpError(405, "method not allowed");
    const type = (req.headers["content-type"] ?? "").split(";")[0]!.trim().toLowerCase();
    if (type !== "application/json") throw new HttpError(415, "the body must be application/json");
    if (path === "/api/session") {
      const body = await readJson(req);
      // One trade only, and only while the code is fresh: the URL may be seen by others (process arguments, history).
      const valid = typeof body.code === "string" && codeDigest !== undefined && same(body.code, codeDigest) && now() <= codeExpires;
      if (!valid) throw new HttpError(401, "this link was already used or has expired. Restart fusen-web for a new one.");
      codeDigest = undefined;
      return { token };
    }
    const bearer = /^Bearer\s+(.+)$/i.exec(req.headers.authorization ?? "")?.[1] ?? "";
    if (!same(bearer, tokenDigest)) throw new HttpError(401, "unauthorized");
    const body = await readJson(req);
    switch (path) {
      case "/api/files":
        return listFiles(options.roots);
      case "/api/open": {
        const next = await View.open(body.path as string, options.roots);
        const previous = view;
        view = next;
        await previous?.close();
        return next.opened;
      }
      case "/api/rows":
        return current(body).rows(body.fingerprint, body.offset, body.limit, body.where);
      case "/api/ref":
        return { ref: await current(body).ref(body.fingerprint, body.ranges, body.where, body.columns) };
      default:
        throw new HttpError(404, "not found");
    }
  }

  // Another tab may have opened another file since this one was read.
  function current(body: Record<string, unknown>): View {
    if (!view) throw new FusenError("open a file first");
    if (body.source !== view.opened.source) throw new SourceChanged("another file was opened since. Open this one again.");
    return view;
  }

  const http = createServer(async (req, res) => {
    if (!allowedHosts.includes(req.headers.host ?? "")) return send(res, 403, { error: "forbidden host" });
    const origin = req.headers.origin;
    if (origin !== undefined && !allowedOrigins.includes(origin)) return send(res, 403, { error: "forbidden origin" });
    const path = new URL(req.url ?? "/", "http://localhost").pathname;
    if (!path.startsWith("/api/")) {
      const file = files[path];
      if (!file) return send(res, 404, { error: "not found" });
      if (req.method !== "GET" && req.method !== "HEAD") return send(res, 405, { error: "method not allowed" }, { allow: "GET" });
      res.writeHead(200, { ...SECURITY_HEADERS, "content-type": file.type });
      return res.end(req.method === "HEAD" ? undefined : file.body);
    }
    try {
      send(res, 200, await api(req, path));
    } catch (error) {
      if (error instanceof HttpError) {
        return send(res, error.status, { error: error.message }, error.status === 401 ? { "www-authenticate": "Bearer" } : {});
      }
      if (!(error instanceof FusenError)) console.error(logLine(error));
      // Engine messages can quote cell values; only messages core built itself reach the page.
      const changed = error instanceof SourceChanged;
      send(res, changed ? 409 : error instanceof FusenError ? 400 : 500, { error: describeError(error), changed });
    }
  });

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
    url: `http://${hostPart}:${port}/#c=${code}`,
    close: async () => {
      await new Promise<void>((resolve, reject) => {
        http.close((error) => (error ? reject(error) : resolve()));
        http.closeAllConnections();
      });
      await view?.close();
    },
  };
}
