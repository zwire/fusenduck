// The fusenduck Web UI: open a Parquet file, see its card and rows, select rows, copy the Ref.
// Values from the file are untrusted: they reach the DOM through textContent only, never as markup
// (the CSP also makes the browser refuse strings assigned to innerHTML). See docs/adr/0002.
import { ApiError, exchange, httpApi, type Api, type Opened, type Page, type Range } from "./api.js";

const PAGE_ROWS = 100;
const MAX_CELL_CHARS = 200;
const TOKEN_KEY = "fusenduck-token";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const status = $<HTMLParagraphElement>("status");
const pathInput = $<HTMLInputElement>("path");
const refInput = $<HTMLInputElement>("ref");
const rowsTable = $<HTMLTableElement>("rows");

function say(message: string, error = false): void {
  status.textContent = message;
  status.classList.toggle("error", error);
}

const sentence = (message: string) => message.charAt(0).toUpperCase() + message.slice(1);
const describe = (error: unknown) => (error instanceof ApiError ? sentence(error.message) : "The server could not be reached.");

function cell(tag: "td" | "th", text: string | null, className?: string): HTMLElement {
  const el = document.createElement(tag);
  el.textContent = text ?? "NULL";
  if (text === null) el.classList.add("null");
  if (className) el.classList.add(className);
  return el;
}

function row(tag: "td" | "th", values: (string | null)[]): HTMLTableRowElement {
  const tr = document.createElement("tr");
  for (const v of values) tr.append(cell(tag, v));
  return tr;
}

// The selection: sorted ranges of positions that neither overlap nor touch.
let ranges: Range[] = [];
let anchor: number | undefined;

const selected = (pos: number) => ranges.some(([a, b]) => a <= pos && pos <= b);
const count = () => ranges.reduce((n, [a, b]) => n + b - a + 1, 0);

function normalize(list: Range[]): Range[] {
  const sorted = [...list].sort((x, y) => x[0] - y[0]);
  const out: Range[] = [];
  for (const [a, b] of sorted) {
    const last = out.at(-1);
    if (last && a <= last[1] + 1) last[1] = Math.max(last[1], b);
    else out.push([a, b]);
  }
  return out;
}

function toggle(pos: number): Range[] {
  if (!selected(pos)) return normalize([...ranges, [pos, pos]]);
  return ranges.flatMap(([a, b]): Range[] => {
    if (pos < a || pos > b) return [[a, b]];
    return [...(a < pos ? [[a, pos - 1] as Range] : []), ...(pos < b ? [[pos + 1, b] as Range] : [])];
  });
}

let api: Api | undefined;
let file: Opened | undefined;
let offsets: number[] = [];
let page: Page | undefined;
// Each selection mints its Ref on the server. Only the newest mint may fill the field, and Copy
// waits for it, so a click followed at once by Copy never copies the Ref of the selection before.
let seq = 0;
let loading = false;
let latest: Promise<string | undefined> = Promise.resolve(undefined);

function showCard(opened: Opened): void {
  $("source").textContent = `${opened.source} — ${opened.card.rows} rows`;
  const table = $<HTMLTableElement>("card");
  table.replaceChildren(
    row("th", ["column", "type", "min", "max", "null %", "approx_unique", "avg"]),
    ...opened.card.columns.map((c) =>
      row("td", [c.column, c.type, c.min, c.max, c.null_percentage, String(c.approx_unique), c.avg]),
    ),
  );
  $("card-section").hidden = false;
}

function showRows(): void {
  if (!file || !page) return;
  const head = document.createElement("thead");
  head.append(row("th", ["#", ...file.card.columns.map((c) => c.column)]));
  const body = document.createElement("tbody");
  const offset = offsets.at(-1) ?? 0;
  page.rows.forEach((r, i) => {
    const tr = row("td", r.cells);
    tr.prepend(cell("td", String(r.pos ?? offset + i), "pos"));
    if (r.pos !== null) {
      tr.dataset.pos = String(r.pos);
      tr.classList.toggle("selected", selected(r.pos));
      tr.setAttribute("aria-selected", String(selected(r.pos)));
    }
    body.append(tr);
  });
  rowsTable.replaceChildren(head, body);
  rowsTable.classList.toggle("locked", !file.selectable);
  const last = offset + page.rows.length;
  $("page").textContent = page.rows.length ? `rows ${offset + 1}–${last} of ${file.card.rows}` : `no rows (${file.card.rows} in the file)`;
  $<HTMLButtonElement>("prev").disabled = offsets.length < 2;
  $<HTMLButtonElement>("next").disabled = page.next === null;
  $("rows-note").textContent =
    `# is the row's position in the file, from 0. Cells longer than ${MAX_CELL_CHARS} characters are cut (marked with …).` +
    (page.cut ? ` This page stopped at row ${last} because its cells are large; Next goes on from there.` : "");
  $("rows-section").hidden = false;
}

function showSelection(): void {
  if (!file) return;
  for (const tr of rowsTable.querySelectorAll<HTMLTableRowElement>("tbody tr[data-pos]")) {
    const on = selected(Number(tr.dataset.pos));
    tr.classList.toggle("selected", on);
    tr.setAttribute("aria-selected", String(on));
  }
  $("selection").textContent = !file.selectable
    ? "This file has its own column named file_row_number, so rows cannot be selected by position. The Ref is for the whole file."
    : ranges.length
      ? `${count()} rows selected (${ranges.length} ${ranges.length === 1 ? "range" : "ranges"}). Copy gives the Ref for exactly these rows.`
      : "Nothing selected: the Ref is for the whole file. Click a row; Shift+click selects a range, Ctrl/⌘+click adds or removes a row.";
}

function selectionChanged(): void {
  showSelection();
  if (!api || !file) return;
  const mine = ++seq;
  if (!ranges.length) {
    refInput.value = file.ref;
    latest = Promise.resolve(file.ref);
    return;
  }
  refInput.value = "";
  refInput.placeholder = "Making the Ref…";
  const opened = file;
  latest = api.ref(opened, ranges.map(([a, b]): Range => [a, b])).then(
    (ref) => {
      if (mine === seq) refInput.value = ref;
      return ref;
    },
    (error: unknown) => {
      if (mine === seq) say(describe(error), true);
      return undefined;
    },
  );
}

async function loadPage(offset: number): Promise<void> {
  if (!api || !file) return;
  loading = true;
  try {
    page = await api.rows(file, offset, PAGE_ROWS);
    showRows();
  } catch (error) {
    say(describe(error), true);
  } finally {
    loading = false;
  }
}

async function open(path: string): Promise<void> {
  if (!api) return;
  say("Opening…");
  try {
    file = await api.open(path);
  } catch (error) {
    say(describe(error), true);
    return;
  }
  // The rows of the previous file must not be clickable against this one.
  page = undefined;
  rowsTable.replaceChildren();
  ranges = [];
  anchor = undefined;
  offsets = [0];
  seq += 1;
  refInput.value = file.ref;
  latest = Promise.resolve(file.ref);
  showCard(file);
  await loadPage(0);
  showSelection();
  say(file.selectable ? "" : "Rows of this file cannot be selected: see below.");
}

$<HTMLFormElement>("open-form").addEventListener("submit", (event) => {
  event.preventDefault();
  void open(pathInput.value.trim());
});

rowsTable.addEventListener("click", (event) => {
  const tr = (event.target as Element).closest<HTMLTableRowElement>("tbody tr[data-pos]");
  if (!tr || !file?.selectable) return;
  const pos = Number(tr.dataset.pos);
  if (event.shiftKey && anchor !== undefined) {
    const span: Range = [Math.min(anchor, pos), Math.max(anchor, pos)];
    ranges = event.ctrlKey || event.metaKey ? normalize([...ranges, span]) : [span];
  } else if (event.ctrlKey || event.metaKey) {
    ranges = toggle(pos);
    anchor = pos;
  } else {
    ranges = [[pos, pos]];
    anchor = pos;
  }
  say("");
  selectionChanged();
});

$("copy").addEventListener("click", async () => {
  const ref = await latest;
  if (ref === undefined) return;
  try {
    await navigator.clipboard.writeText(ref);
    say(ranges.length ? `Copied the Ref for ${count()} rows.` : "Copied the Ref for the whole file.");
  } catch {
    refInput.select();
    say("The browser refused the clipboard: the Ref is selected in the field, copy it from there.", true);
  }
});

$("next").addEventListener("click", () => {
  if (loading || page?.next == null) return;
  offsets.push(page.next);
  void loadPage(page.next);
});

$("prev").addEventListener("click", () => {
  if (loading || offsets.length < 2) return;
  offsets.pop();
  void loadPage(offsets.at(-1) ?? 0);
});

// The code in the URL fragment is traded once for the session token, which stays in this tab only.
// The fragment is removed first, so the code does not linger in the address bar.
async function start(): Promise<void> {
  const code = new URLSearchParams(location.hash.slice(1)).get("c");
  if (location.hash) history.replaceState(null, "", location.pathname);
  let token = sessionStorage.getItem(TOKEN_KEY);
  if (code) {
    try {
      token = await exchange(code);
      sessionStorage.setItem(TOKEN_KEY, token);
    } catch (error) {
      if (!token) say(describe(error), true);
    }
  }
  if (!token) {
    if (!status.textContent) say("Open the URL that fusen-web printed when it started.", true);
    $<HTMLButtonElement>("open").disabled = true;
    return;
  }
  api = httpApi(token);
  pathInput.focus();
}

void start();
