// The fusenduck Web UI: open a Parquet file, see its card and rows, pick columns, filter and select
// rows, copy the Ref.
// Values from the file are untrusted: they reach the DOM through textContent only, never as markup
// (the CSP also makes the browser refuse strings assigned to innerHTML). See docs/adr/0002.
import { ApiError, exchange, httpApi, type Api, type Listed, type ListedFile, type Opened, type Page, type Range, type Selection } from "./api.js";

const PAGE_ROWS = 100;
/** Files shown in the list at once; the filter narrows the rest. */
const MAX_SHOWN = 300;
const MAX_CELL_CHARS = 200;
const TOKEN_KEY = "fusenduck-token";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const status = $<HTMLParagraphElement>("status");
const pathInput = $<HTMLInputElement>("path");
const refInput = $<HTMLInputElement>("ref");
const rowsTable = $<HTMLTableElement>("rows");
const filterInput = $<HTMLInputElement>("filter");
const whereInput = $<HTMLInputElement>("where");
const filesList = $<HTMLUListElement>("files");

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
// The pages walked so far: where each starts (a position, or an offset in a file whose rows cannot be
// selected) and how many matching rows come before it.
let offsets: { at: number; index: number }[] = [];
let page: Page | undefined;
let pageSeq = 0;
// The filter the rows on screen pass (not the text being typed), and the columns left out of the Ref.
let filter: string | undefined;
let hidden = new Set<string>();

/** The columns the Ref keeps, in the file's order; undefined when it keeps them all. */
function kept(): string[] | undefined {
  if (!file || hidden.size === 0) return undefined;
  return file.card.columns.map((c) => c.column).filter((c) => !hidden.has(c));
}
// Each selection mints its Ref on the server. Only the newest mint may fill the field, and Copy
// waits for it, so a click followed at once by Copy never copies the Ref of the selection before.
let seq = 0;
let loading = false;
let latest: Promise<string | undefined> = Promise.resolve(undefined);

function checkbox(label: string, checked: boolean, column?: string): HTMLInputElement {
  const box = document.createElement("input");
  box.type = "checkbox";
  box.checked = checked;
  box.setAttribute("aria-label", label);
  if (column !== undefined) box.dataset.column = column;
  return box;
}

function showCard(opened: Opened): void {
  $("source").textContent = `${opened.source} — ${opened.card.rows} rows`;
  const table = $<HTMLTableElement>("card");
  const head = row("th", ["column", "type", "min", "max", "null %", "approx_unique", "avg"]);
  const all = document.createElement("th");
  all.append(checkbox("Keep every column in the Ref", true));
  all.id = "keep-all";
  head.prepend(all);
  table.replaceChildren(
    head,
    ...opened.card.columns.map((c) => {
      const tr = row("td", [c.column, c.type, c.min, c.max, c.null_percentage, String(c.approx_unique), c.avg]);
      const keep = document.createElement("td");
      keep.append(checkbox(`Keep ${c.column} in the Ref`, true, c.column));
      tr.prepend(keep);
      return tr;
    }),
  );
  $("card-section").hidden = false;
}

function showColumns(): void {
  if (!file) return;
  for (const box of $("card").querySelectorAll<HTMLInputElement>("input[data-column]")) {
    box.checked = !hidden.has(box.dataset.column!);
  }
  const all = $("keep-all").querySelector("input")!;
  all.checked = hidden.size === 0;
  all.indeterminate = hidden.size > 0;
}

function showRows(): void {
  if (!file || !page) return;
  const columns = file.card.columns.map((c) => c.column);
  const shown = columns.map((c) => !hidden.has(c));
  const head = document.createElement("thead");
  head.append(row("th", ["#", ...columns.filter((_, i) => shown[i])]));
  const body = document.createElement("tbody");
  const { at, index } = offsets.at(-1) ?? { at: 0, index: 0 };
  page.rows.forEach((r, i) => {
    const tr = row("td", r.cells.filter((_, j) => shown[j]));
    tr.prepend(cell("td", String(r.pos ?? at + i), "pos"));
    if (r.pos !== null) {
      tr.dataset.pos = String(r.pos);
      tr.classList.toggle("selected", selected(r.pos));
      tr.setAttribute("aria-selected", String(selected(r.pos)));
    }
    body.append(tr);
  });
  rowsTable.replaceChildren(head, body);
  rowsTable.classList.toggle("locked", !file.selectable);
  const last = index + page.rows.length;
  const of = filter === undefined ? `of ${file.card.rows}` : `of ${page.matched} matching the filter (${file.card.rows} in the file)`;
  $("page").textContent = page.rows.length
    ? `rows ${index + 1}–${last} ${of}`
    : filter === undefined
      ? `no rows (${file.card.rows} in the file)`
      : `no rows match the filter (${file.card.rows} in the file)`;
  $<HTMLButtonElement>("prev").disabled = offsets.length < 2;
  $<HTMLButtonElement>("next").disabled = page.next === null;
  const hiddenNote = hidden.size ? ` ${hidden.size} ${hidden.size === 1 ? "column is" : "columns are"} left out of the Ref and not shown.` : "";
  $("rows-note").textContent =
    `# is the row's position in the file, from 0. Cells longer than ${MAX_CELL_CHARS} characters are cut (marked with …).` +
    hiddenNote +
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
  const how = !file.selectable
    ? " This file has its own column named file_row_number, so rows cannot be selected by position; use the filter instead."
    : ranges.length
      ? ""
      : " Click a row to select it; Shift+click selects a range, Ctrl/⌘+click adds or removes a row.";
  $("selection").textContent = `The Ref covers ${covers(file)}.${how}`;
}

/** What the Ref covers, in words: which rows, which columns. */
function covers(opened: Opened): string {
  const columns = kept();
  const picked = `${count()} selected ${count() === 1 ? "position" : "positions"} (${ranges.length} ${ranges.length === 1 ? "range" : "ranges"})`;
  const which = ranges.length
    ? filter !== undefined
      ? `the rows that match the filter within ${picked}`
      : `${count()} selected ${count() === 1 ? "row" : "rows"} (${ranges.length} ${ranges.length === 1 ? "range" : "ranges"})`
    : filter !== undefined
      ? "the rows that match the filter"
      : "every row";
  if (which === "every row" && !columns) return "the whole file";
  const cols = columns ? `${columns.length} of ${opened.card.columns.length} columns (${columns.join(", ")})` : "every column";
  return `${which}, ${cols}`;
}

/** What the Ref covers now; undefined when it is the whole file, whose Ref came with it. */
function selection(): Selection | undefined {
  const columns = kept();
  if (!ranges.length && filter === undefined && !columns) return undefined;
  return {
    ranges: ranges.map(([a, b]): Range => [a, b]),
    ...(filter === undefined ? {} : { where: filter }),
    ...(columns ? { columns } : {}),
  };
}

function selectionChanged(): void {
  showSelection();
  if (!api || !file) return;
  const mine = ++seq;
  const wanted = selection();
  if (!wanted) {
    refInput.value = file.ref;
    latest = Promise.resolve(file.ref);
    return;
  }
  refInput.value = "";
  refInput.placeholder = "Making the Ref…";
  latest = api.ref(file, wanted).then(
    (ref) => {
      if (mine === seq) refInput.value = ref;
      return ref;
    },
    (error: unknown) => {
      if (mine === seq) {
        refInput.placeholder = "";
        say(describe(error), true);
      }
      return undefined;
    },
  );
}

/**
 * Shows the page at `at` under `where`, then `walked` becomes the pages walked so far. "stale" means
 * a newer load (another page, filter or file) took its place, so nothing changed.
 */
async function loadPage(
  at: number,
  index: number,
  where: string | undefined,
  walked: { at: number; index: number }[],
): Promise<"shown" | "failed" | "stale"> {
  if (!api || !file) return "stale";
  const mine = ++pageSeq;
  loading = true;
  try {
    const next = await api.rows(file, at, PAGE_ROWS, where);
    if (mine !== pageSeq) return "stale";
    page = next;
    filter = where;
    offsets = walked;
    showRows();
    return "shown";
  } catch (error) {
    if (mine !== pageSeq) return "stale";
    say(describe(error), true);
    return "failed";
  } finally {
    if (mine === pageSeq) loading = false;
  }
}

async function applyFilter(text: string): Promise<void> {
  if (!file) return;
  const where = text.trim() || undefined;
  say(where === undefined ? "" : "Filtering…");
  const result = await loadPage(0, 0, where, [{ at: 0, index: 0 }]);
  if (result === "stale") return;
  if (result === "failed") {
    whereInput.setAttribute("aria-invalid", "true");
    return;
  }
  whereInput.removeAttribute("aria-invalid");
  // Selected rows may not pass the new filter; start the selection again.
  ranges = [];
  anchor = undefined;
  say(where === undefined ? "" : `${page!.matched} of ${file.card.rows} rows match the filter.`);
  selectionChanged();
}

// The files under the roots. The filter keeps the files whose path holds every word typed; the
// arrow keys move through the list and Enter opens the file, so the mouse is never needed.
let listed: Listed | undefined;
let shown: ListedFile[] = [];
let active = 0;

function size(bytes: number): string {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let n = bytes;
  let i = 0;
  for (; n >= 1024 && i < units.length - 1; i++) n /= 1024;
  return `${i === 0 ? n : n.toFixed(n < 10 ? 1 : 0)} ${units[i]}`;
}

function span(className: string, text: string): HTMLSpanElement {
  const el = document.createElement("span");
  el.className = className;
  el.textContent = text;
  return el;
}

function showFiles(): void {
  if (!listed) return;
  const words = filterInput.value.toLowerCase().split(/\s+/).filter(Boolean);
  const total = listed.roots.reduce((n, r) => n + r.files.length, 0);
  const items: HTMLLIElement[] = [];
  let matched = 0;
  shown = [];
  for (const { root, files } of listed.roots) {
    // Every listed name ends in .parquet, so the extension would match a "q" or a "p" in every file.
    const hits = files.filter((f) => words.every((w) => f.name.toLowerCase().replace(/\.parquet$/, "").includes(w)));
    matched += hits.length;
    const room = hits.slice(0, MAX_SHOWN - shown.length);
    // With several roots, each one's files come under its name.
    if (listed.roots.length > 1 && room.length) {
      const li = document.createElement("li");
      li.className = "root";
      li.setAttribute("role", "presentation");
      li.textContent = root;
      items.push(li);
    }
    for (const f of room) {
      const li = document.createElement("li");
      li.id = `file-${shown.length}`;
      li.dataset.index = String(shown.length);
      li.setAttribute("role", "option");
      li.title = f.path;
      const slash = f.name.lastIndexOf("/");
      li.append(span("name", f.name.slice(slash + 1)), span("dir", f.name.slice(0, slash + 1)), span("size", size(f.size)));
      li.classList.toggle("current", f.path === file?.source);
      shown.push(f);
      items.push(li);
    }
  }
  filesList.replaceChildren(...items);
  active = Math.min(active, Math.max(shown.length - 1, 0));
  highlight();
  const roots = listed.roots.map((r) => r.root).join(", ");
  $("files-note").textContent =
    total === 0
      ? `No Parquet files under ${roots}. Type a path above instead.`
      : matched === 0
        ? "No file matches the filter."
        : (matched === total ? `${total} ${total === 1 ? "file" : "files"}` : `${matched} of ${total} files`) +
          (matched > shown.length ? `; the first ${shown.length} are shown, type to narrow.` : ".") +
          (listed.truncated
            ? ` Too many files to list whole under ${listed.roots.filter((r) => r.truncated).map((r) => r.root).join(", ")}: some are missing, type a path above to open them.`
            : "");
}

function highlight(scroll = false): void {
  for (const li of filesList.querySelectorAll<HTMLLIElement>("li[data-index]")) {
    const on = Number(li.dataset.index) === active;
    li.classList.toggle("active", on);
    li.setAttribute("aria-selected", String(on));
    if (on && scroll) li.scrollIntoView({ block: "nearest" });
  }
  if (shown.length) filterInput.setAttribute("aria-activedescendant", `file-${active}`);
  else filterInput.removeAttribute("aria-activedescendant");
}

// Only the newest listing may fill the list, so a slow older one never replaces it.
let listing = 0;

async function loadFiles(): Promise<void> {
  if (!api) return;
  const mine = ++listing;
  const reload = $<HTMLButtonElement>("reload");
  $("files-panel").hidden = false;
  reload.disabled = true;
  try {
    const result = await api.files();
    if (mine !== listing) return;
    listed = result;
    showFiles();
  } catch (error) {
    if (mine === listing) $("files-note").textContent = describe(error);
  } finally {
    if (mine === listing) reload.disabled = false;
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
  offsets = [];
  filter = undefined;
  hidden = new Set();
  whereInput.value = "";
  whereInput.removeAttribute("aria-invalid");
  seq += 1;
  refInput.value = file.ref;
  latest = Promise.resolve(file.ref);
  pathInput.value = file.source;
  showCard(file);
  showFiles();
  await loadPage(0, 0, undefined, [{ at: 0, index: 0 }]);
  showSelection();
  say(file.selectable ? "" : "Rows of this file cannot be selected: see below.");
}

$<HTMLFormElement>("open-form").addEventListener("submit", (event) => {
  event.preventDefault();
  void open(pathInput.value.trim());
});

filterInput.addEventListener("input", () => {
  active = 0;
  showFiles();
});

filterInput.addEventListener("keydown", (event) => {
  // Enter and the arrows belong to the input method while it is composing (a Japanese name, say).
  if (event.isComposing || event.keyCode === 229) return;
  if (event.key === "ArrowDown" || event.key === "ArrowUp") {
    event.preventDefault();
    if (!shown.length) return;
    active = (active + (event.key === "ArrowDown" ? 1 : shown.length - 1)) % shown.length;
    highlight(true);
  } else if (event.key === "Enter") {
    event.preventDefault();
    const f = shown[active];
    if (f) void open(f.path);
  } else if (event.key === "Escape" && filterInput.value) {
    event.preventDefault();
    filterInput.value = "";
    active = 0;
    showFiles();
  }
});

filesList.addEventListener("click", (event) => {
  const li = (event.target as Element).closest<HTMLLIElement>("li[data-index]");
  if (!li) return;
  active = Number(li.dataset.index);
  highlight();
  const f = shown[active];
  if (f) void open(f.path);
});

$("reload").addEventListener("click", () => void loadFiles());

// "/" goes to the filter from anywhere but a text field, as in many file pickers.
document.addEventListener("keydown", (event) => {
  const target = event.target as HTMLElement;
  if (event.key !== "/" || event.ctrlKey || event.metaKey || event.altKey || target.closest("input, textarea")) return;
  if ($("files-panel").hidden) return;
  event.preventDefault();
  filterInput.focus();
  filterInput.select();
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

$<HTMLFormElement>("where-form").addEventListener("submit", (event) => {
  event.preventDefault();
  void applyFilter(whereInput.value);
});

$("clear-where").addEventListener("click", () => {
  whereInput.value = "";
  void applyFilter("");
});

$("card").addEventListener("change", (event) => {
  const box = event.target as HTMLInputElement;
  if (!file || box.type !== "checkbox") return;
  const column = box.dataset.column;
  if (column === undefined) hidden = box.checked ? new Set() : new Set(file.card.columns.slice(1).map((c) => c.column));
  else if (box.checked) hidden.delete(column);
  else hidden.add(column);
  if (hidden.size === file.card.columns.length) {
    hidden.delete(column ?? file.card.columns[0]!.column);
    say("A Ref keeps at least one column.", true);
  }
  showColumns();
  showRows();
  selectionChanged();
});

$("copy").addEventListener("click", async () => {
  const ref = await latest;
  if (ref === undefined) return;
  try {
    await (api?.copy ? api.copy(ref) : navigator.clipboard.writeText(ref));
    if (file) say(`Copied the Ref for ${covers(file)}.`);
  } catch (error) {
    refInput.select();
    if (api?.copy) return say(`${describe(error).replace(/\.$/, "")}. The Ref is selected in the field, copy it from there.`, true);
    say("The browser refused the clipboard: the Ref is selected in the field, copy it from there.", true);
  }
});

$("next").addEventListener("click", () => {
  if (loading || page?.next == null) return;
  const { index } = offsets.at(-1) ?? { index: 0 };
  const at = { at: page.next, index: index + page.rows.length };
  void loadPage(at.at, at.index, filter, [...offsets, at]);
});

$("prev").addEventListener("click", () => {
  if (loading || offsets.length < 2) return;
  const walked = offsets.slice(0, -1);
  const { at, index } = walked.at(-1) ?? { at: 0, index: 0 };
  void loadPage(at, index, filter, walked);
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
  await loadFiles();
  (shown.length ? filterInput : pathInput).focus();
}

/**
 * Starts the page on an Api from another host (the VS Code webview), with its one file already chosen.
 * The path stays in the field, and Open becomes Reload, so a changed file can be read again.
 */
export function mount(host: Api, path: string): void {
  api = host;
  pathInput.value = path;
  pathInput.readOnly = true;
  $<HTMLButtonElement>("open").textContent = "Reload";
  void open(path);
}

// A host that supplies its own Api marks the page (<html data-host>) and calls mount itself.
if (document.documentElement.dataset.host === undefined) void start();
