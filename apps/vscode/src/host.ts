import { realpathSync } from "node:fs";
import { dirname } from "node:path";
import { describeError, FusenError, logLine, parseRef, SourceChanged } from "@fusenduck/core";
import { View } from "@fusenduck/web/view";

// The extension host's side of one webview (docs/adr/0002, the VS Code webview). The webview sends
// { id, method, params } and gets { id, result } or { id, error, changed } back. There is no port and
// no token: only this extension's own webview can post to it. The panel is for one file, so open
// accepts that file only, and the engine may read only its folder.

export const METHODS = ["init", "open", "rows", "ref", "copy"] as const;
export type Method = (typeof METHODS)[number];

export interface Request {
  id: number;
  method: Method;
  params: Record<string, unknown>;
}

export type Reply = { id: number; result: unknown } | { id: number; error: string; changed: boolean };

export interface HostOptions {
  /** The absolute path of the file this panel shows. */
  path: string;
  /** The folders the engine may read. */
  roots: string[];
  /** Puts text on the clipboard (vscode.env.clipboard in the extension). */
  copy(text: string): Promise<void>;
  /** Where unexpected errors go, as logLine words them; the webview sees only describeError's message. */
  log?(line: string): void;
  /** Added to the page's message for an error whose details went to log instead. */
  withheld?: string;
}

/**
 * The folder the engine may read for `path`: the folder of the file it resolves to, since core checks
 * the real path of a source against its roots (a symlink to a file elsewhere would be refused).
 */
export function rootFor(path: string): string {
  try {
    return dirname(realpathSync(path));
  } catch {
    // A missing file: opening it fails with core's own message.
    return dirname(path);
  }
}

/** A message from the webview, or undefined when it is not one. */
export function parseRequest(message: unknown): Request | undefined {
  if (typeof message !== "object" || message === null) return undefined;
  const { id, method, params } = message as Record<string, unknown>;
  if (!Number.isSafeInteger(id) || !(METHODS as readonly unknown[]).includes(method)) return undefined;
  if (params !== undefined && (typeof params !== "object" || params === null || Array.isArray(params))) return undefined;
  return { id: id as number, method: method as Method, params: (params ?? {}) as Record<string, unknown> };
}

function isRef(text: string): boolean {
  try {
    parseRef(text);
    return true;
  } catch {
    return false;
  }
}

export class Host {
  readonly #options: HostOptions;
  #view: View | undefined;
  #closed = false;
  /** Aborted when the editor closes, so a query still running for it stops. */
  readonly #leaving = new AbortController();

  constructor(options: HostOptions) {
    this.#options = options;
  }

  /** Answers one message from the webview. Messages that are not requests get no answer. */
  async handle(message: unknown): Promise<Reply | undefined> {
    const request = parseRequest(message);
    if (!request) return undefined;
    try {
      return { id: request.id, result: await this.#run(request) };
    } catch (error) {
      // Engine messages can quote cell values; only messages core built itself reach the page.
      let message = describeError(error);
      if (!(error instanceof FusenError)) {
        this.#options.log?.(logLine(error));
        if (this.#options.log && this.#options.withheld) message = `${message} ${this.#options.withheld}`;
      }
      return { id: request.id, error: message, changed: error instanceof SourceChanged };
    }
  }

  async #run({ method, params }: Request): Promise<unknown> {
    if (this.#closed) throw new FusenError("this editor was closed");
    switch (method) {
      case "init":
        return { path: this.#options.path };
      case "open": {
        if (params.path !== this.#options.path) throw new FusenError("this editor shows one file only; open others from the explorer");
        const next = await View.open(this.#options.path, this.#options.roots);
        // The editor may have closed while the file was opening; its engine must not outlive it.
        if (this.#closed) {
          await next.close();
          throw new FusenError("this editor was closed");
        }
        const previous = this.#view;
        this.#view = next;
        await previous?.close();
        return next.opened;
      }
      case "rows":
        return this.#current(params).rows(params.fingerprint, params.offset, params.limit, params.where, this.#leaving.signal);
      case "ref":
        return this.#current(params).ref(params.fingerprint, params.ranges, params.where, params.columns, this.#leaving.signal);
      case "copy":
        if (typeof params.text !== "string" || !isRef(params.text)) throw new FusenError("only a Ref can be copied");
        await this.#options.copy(params.text);
        return null;
    }
  }

  // Every open is of the same file, so source only tells a request from before any open; a request
  // from before a reload reaches the new view, where the fingerprint check guards it.
  #current(params: Record<string, unknown>): View {
    if (!this.#view) throw new FusenError("open the file first");
    if (params.source !== this.#view.opened.source) throw new FusenError("open the file first");
    return this.#view;
  }

  /** Closes the engine; later messages are refused. */
  async close(): Promise<void> {
    this.#closed = true;
    this.#leaving.abort();
    await this.#view?.close();
  }
}
