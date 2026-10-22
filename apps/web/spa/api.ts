// How the SPA reaches core. The page only ever talks to an Api, so a host other than the local
// server (the VS Code webview, later) can supply its own. Types mirror apps/web/src/view.ts; the API
// is internal and unversioned (docs/adr/0002).

export interface CardColumn {
  column: string;
  type: string;
  min: string | null;
  max: string | null;
  approx_unique: number;
  null_percentage: string;
  avg: string | null;
}

export interface Opened {
  source: string;
  fingerprint: string;
  card: { rows: number; columns: CardColumn[]; approximate: string[] };
  ref: string;
  selectable: boolean;
}

export interface Page {
  rows: { pos: number | null; cells: (string | null)[] }[];
  next: number | null;
  cut: boolean;
}

export type Range = [number, number];

export interface Api {
  open(path: string): Promise<Opened>;
  rows(file: Opened, offset: number, limit: number): Promise<Page>;
  ref(file: Opened, ranges: Range[]): Promise<string>;
}

/** An error the server described; `changed` means the file changed since it was opened. */
export class ApiError extends Error {
  constructor(
    message: string,
    readonly changed: boolean,
  ) {
    super(message);
  }
}

async function post<T>(path: string, body: unknown, token?: string): Promise<T> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (token) headers.authorization = `Bearer ${token}`;
  const res = await fetch(path, { method: "POST", headers, body: JSON.stringify(body), credentials: "omit" });
  const data = (await res.json()) as { error?: string; changed?: boolean };
  if (!res.ok) throw new ApiError(data.error ?? `request failed (${res.status})`, data.changed === true);
  return data as T;
}

/** Trades the one-time code from the URL for the session token. */
export async function exchange(code: string): Promise<string> {
  return (await post<{ token: string }>("/api/session", { code })).token;
}

/** The local server's API, on the page's own origin. */
export function httpApi(token: string): Api {
  return {
    open: (path) => post<Opened>("/api/open", { path }, token),
    rows: (file, offset, limit) => post<Page>("/api/rows", { source: file.source, fingerprint: file.fingerprint, offset, limit }, token),
    ref: async (file, ranges) =>
      (await post<{ ref: string }>("/api/ref", { source: file.source, fingerprint: file.fingerprint, ranges }, token)).ref,
  };
}
