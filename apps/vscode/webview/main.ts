// The webview's entry: the Web UI's page (apps/web/spa) on an Api that sends messages to the
// extension host instead of calling the local server. Answers come back as message events.
import { ApiError, type Api, type Opened, type Page, type Range } from "../../web/spa/api.js";
import { mount } from "../../web/spa/app.js";

declare function acquireVsCodeApi(): { postMessage(message: unknown): void };

const vscode = acquireVsCodeApi();
const pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void }>();
let next = 0;

window.addEventListener("message", (event: MessageEvent) => {
  const reply = event.data as { id?: unknown; result?: unknown; error?: unknown; changed?: unknown };
  const waiting = typeof reply?.id === "number" ? pending.get(reply.id) : undefined;
  if (!waiting) return;
  pending.delete(reply.id as number);
  if (typeof reply.error === "string") waiting.reject(new ApiError(reply.error, reply.changed === true));
  else waiting.resolve(reply.result);
});

function call<T>(method: string, params: Record<string, unknown> = {}): Promise<T> {
  const id = ++next;
  return new Promise<T>((resolve, reject) => {
    pending.set(id, { resolve: resolve as (value: unknown) => void, reject });
    vscode.postMessage({ id, method, params });
  });
}

const api: Api = {
  open: (path) => call<Opened>("open", { path }),
  rows: (file, offset, limit) => call<Page>("rows", { source: file.source, fingerprint: file.fingerprint, offset, limit }),
  ref: (file, ranges: Range[]) => call<string>("ref", { source: file.source, fingerprint: file.fingerprint, ranges }),
  copy: (text) => call<void>("copy", { text }),
};

void call<{ path: string }>("init").then(({ path }) => mount(api, path));
