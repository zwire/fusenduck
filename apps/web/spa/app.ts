// The fusenduck Web UI: open a data file, see its card and rows, pick columns, filter and select
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
const whereError = $<HTMLParagraphElement>("where-error");
const copyButton = $<HTMLButtonElement>("copy");

function say(message: string, error = false): void {
  status.textContent = message;
  status.classList.toggle("error", error);
}

const sentence = (message: string) => message.charAt(0).toUpperCase() + message.slice(1);
const describe = (error: unknown) => (error instanceof ApiError ? sentence(error.message) : "The server could not be reached.");
/** A count with thousands separators: 200,000 reads at a glance, 200000 does not. */
const n = (count: number) => count.toLocaleString("en-US");
const plural = (count: number, one: string, many = `${one}s`) => `${n(count)} ${count === 1 ? one : many}`;
const NUMERIC = /^(U?(TINYINT|SMALLINT|INTEGER|BIGINT|HUGEINT)|FLOAT|DOUBLE|DECIMAL)\b/;
/** Past this many columns the card starts folded, so the rows are in view without scrolling past it. */
const CARD_OPEN_COLUMNS = 12;

function cell(tag: "td" | "th", text: string | null, className?: string): HTMLElement {
  const el = document.createElement(tag);
  el.textContent = text ?? "NULL";
  if (text === null) el.classList.add("null");
  if (className) el.classList.add(className);
  // A cell cut by the column width shows its whole text on hover.
  if (text !== null && text.length > 30) el.title = text;
  return el;
}

function row(tag: "td" | "th", values: (string | null)[], classes: (string | undefined)[] = []): HTMLTableRowElement {
  const tr = document.createElement("tr");
  values.forEach((v, i) => tr.append(cell(tag, v, classes[i])));
  return tr;
}

// The selection: sorted ranges of positions that neither overlap nor touch.
let ranges: Range[] = [];
let anchor: number | undefined;
// The row the keyboard is on, as an index into the page.
let cursor: number | undefined;

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
  const slash = Math.max(opened.source.lastIndexOf("/"), opened.source.lastIndexOf("\\"));
  const server = opened.kind === "postgres" || opened.kind === "mysql";
  const name = server ? (opened.table ?? "") : opened.source.slice(slash + 1);
  const source = $("source");
  const suffix = opened.table === undefined || server ? "" : ` #${opened.table}`;
  source.textContent = `${name}${suffix} — ${plural(opened.card.rows, "row")}`;
  source.title = opened.source;
  $("source-dir").textContent = server ? `in ${opened.kind} connection ${opened.source.split("/")[2]}` : `in ${opened.source.slice(0, slash + 1)}`;
  document.title = `${name} — fusenduck`;
  $<HTMLDetailsElement>("card-details").open = opened.card.columns.length <= CARD_OPEN_COLUMNS;
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
  showSummary();
}

function showSummary(): void {
  if (!file) return;
  const total = file.card.columns.length;
  const keep = total - hidden.size;
  $("card-summary").textContent = `Columns and statistics: ${keep === total ? `all ${plural(total, "column")}` : `${n(keep)} of ${n(total)} columns`} in the Ref`;
}

function showRows(): void {
  if (!file || !page) return;
  const columns = file.card.columns.map((c) => c.column);
  const shown = columns.map((c) => !hidden.has(c));
  // Numbers line up on the right, as in a spreadsheet.
  const classes = file.card.columns.filter((_, i) => shown[i]).map((c) => (NUMERIC.test(c.type) ? "num" : undefined));
  const head = document.createElement("thead");
  head.append(row("th", ["#", ...columns.filter((_, i) => shown[i])]));
  const body = document.createElement("tbody");
  const { at, index } = offsets.at(-1) ?? { at: 0, index: 0 };
  page.rows.forEach((r, i) => {
    const tr = row("td", r.cells.filter((_, j) => shown[j]), classes);
    tr.prepend(cell("td", String(r.pos ?? at + i), "pos"));
    if (r.pos !== null) {
      tr.dataset.pos = String(r.pos);
      tr.classList.toggle("selected", selected(r.pos));
      tr.setAttribute("aria-selected", String(selected(r.pos)));
    }
    tr.id = `row-${i}`;
    tr.classList.toggle("cursor", i === cursor);
    body.append(tr);
  });
  rowsTable.replaceChildren(head, body);
  rowsTable.classList.toggle("locked", !file.selectable);
  // The rows take the keyboard only when they can be selected.
  if (file.selectable) rowsTable.tabIndex = 0;
  else rowsTable.removeAttribute("tabindex");
  rowsTable.setAttribute("aria-multiselectable", String(file.selectable));
  if (cursor === undefined) rowsTable.removeAttribute("aria-activedescendant");
  else rowsTable.setAttribute("aria-activedescendant", `row-${cursor}`);
  const last = index + page.rows.length;
  const of = filter === undefined ? `of ${n(file.card.rows)}` : `of ${n(page.matched)} matching the filter (${n(file.card.rows)} in the file)`;
  $("page").textContent = page.rows.length
    ? `rows ${n(index + 1)}–${n(last)} ${of}`
    : filter === undefined
      ? `no rows (${n(file.card.rows)} in the file)`
      : `no rows match the filter (${n(file.card.rows)} in the file)`;
  $<HTMLButtonElement>("prev").disabled = offsets.length < 2;
  $<HTMLButtonElement>("next").disabled = page.next === null;
  const hiddenNote = hidden.size ? ` ${hidden.size} ${hidden.size === 1 ? "column is" : "columns are"} left out of the Ref and not shown.` : "";
  $("rows-note").textContent =
    `# is the row's position in ${file.files > 1 ? "the files, taken in name order" : "the file"}, from 0. Cells longer than ${MAX_CELL_CHARS} characters are cut (marked with …).` +
    hiddenNote +
    (page.cut ? ` This page stopped at row ${n(last)} because its cells are large; Next goes on from there.` : "");
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
    ? ["duckdb", "sqlite", "postgres", "mysql"].includes(file.kind)
      ? " This is a database table, so its rows are selected by a column, not by position: use the filter, e.g. id = 5."
      : " This file has its own column named file_row_number, so rows cannot be selected by position; use the filter instead."
    : ranges.length
      ? ""
      : " Click a row to select it; Shift+click selects a range, Ctrl/⌘+click adds or removes a row. In the rows, ↑↓, Shift+↑↓ and Space do the same.";
  $("selection").textContent = `The Ref covers ${covers(file)}.${how}`;
  $("clear-selection").hidden = ranges.length === 0;
}

/** Moves the keyboard's row to `index` on the page, keeping it in view. */
function moveCursor(index: number): void {
  cursor = index;
  rowsTable.querySelectorAll("tbody tr").forEach((tr, i) => {
    tr.classList.toggle("cursor", i === index);
    if (i === index) tr.scrollIntoView({ block: "nearest" });
  });
  rowsTable.setAttribute("aria-activedescendant", `row-${index}`);
}

/** Selects the row at `pos` the way a click with these keys would. */
function pick(pos: number, keys: { shift: boolean; add: boolean }): void {
  if (keys.shift && anchor !== undefined) {
    const span: Range = [Math.min(anchor, pos), Math.max(anchor, pos)];
    ranges = keys.add ? normalize([...ranges, span]) : [span];
  } else if (keys.add) {
    ranges = toggle(pos);
    anchor = pos;
  } else {
    ranges = [[pos, pos]];
    anchor = pos;
  }
  say("");
  selectionChanged();
}

function clearSelection(): void {
  if (!ranges.length) return;
  ranges = [];
  anchor = undefined;
  say("");
  selectionChanged();
}

/** What the Ref covers, in words: which rows, which columns. */
function covers(opened: Opened): string {
  const columns = kept();
  const picked = `${plural(count(), "selected position")} (${plural(ranges.length, "range")})`;
  const which = ranges.length
    ? filter !== undefined
      ? `the rows that match the filter within ${picked}`
      : `${plural(count(), "selected row")} (${plural(ranges.length, "range")})`
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
  copyDone(false);
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
 * a newer load (another page, filter or file) took its place, so nothing changed. A failure is shown
 * by `report`.
 */
async function loadPage(
  at: number,
  index: number,
  where: string | undefined,
  walked: { at: number; index: number }[],
  report: (error: unknown) => void = (error) => say(describe(error), true),
): Promise<"shown" | "failed" | "stale"> {
  if (!api || !file) return "stale";
  const mine = ++pageSeq;
  loading = true;
  rowsTable.setAttribute("aria-busy", "true");
  try {
    const next = await api.rows(file, at, PAGE_ROWS, where);
    if (mine !== pageSeq) return "stale";
    page = next;
    filter = where;
    offsets = walked;
    if (cursor !== undefined) cursor = Math.min(cursor, Math.max(page.rows.length - 1, 0));
    showRows();
    return "shown";
  } catch (error) {
    if (mine !== pageSeq) return "stale";
    report(error);
    return "failed";
  } finally {
    if (mine === pageSeq) {
      loading = false;
      rowsTable.removeAttribute("aria-busy");
    }
  }
}

async function applyFilter(text: string): Promise<void> {
  if (!file) return;
  const where = text.trim() || undefined;
  say(where === undefined ? "" : "Filtering…");
  // A mistake in the filter is shown under it, where the eyes are; a changed file goes to the status.
  const result = await loadPage(0, 0, where, [{ at: 0, index: 0 }], (error) => {
    if (error instanceof ApiError && !error.changed) {
      say("");
      whereError.textContent = describe(error);
      whereInput.setAttribute("aria-invalid", "true");
    } else {
      // Not about the filter: an older mistake shown under it no longer applies.
      whereError.textContent = "";
      whereInput.removeAttribute("aria-invalid");
      say(describe(error), true);
    }
  });
  if (result === "stale") return;
  if (result === "failed") return;
  whereError.textContent = "";
  whereInput.removeAttribute("aria-invalid");
  // Selected rows may not pass the new filter; start the selection again.
  const dropped = ranges.length > 0;
  ranges = [];
  anchor = undefined;
  cursor = undefined;
  const cleared = dropped ? " The selection was cleared." : "";
  say(where === undefined ? cleared.trim() : `${n(page!.matched)} of ${n(file.card.rows)} rows match the filter.${cleared}`);
  selectionChanged();
}

// The files under the roots. The filter keeps the files whose path holds every word typed; the
// arrow keys move through the list and Enter opens the file, so the mouse is never needed.
let listed: Listed | undefined;
let shown: ListedFile[] = [];
let active = 0;
/** The tables of the DuckDB files that were opened up in the list, by file path. */
const tablesOpen = new Map<string, string[]>();

function size(bytes: number): string {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let i = 0;
  for (; value >= 1024 && i < units.length - 1; i++) value /= 1024;
  return `${i === 0 ? value : value.toFixed(value < 10 ? 1 : 0)} ${units[i]}`;
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
  const total = listed.roots.reduce((sum, r) => sum + r.files.length, 0);
  const items: HTMLLIElement[] = [];
  let matched = 0;
  shown = [];
  const render = (f: ListedFile): void => {
    const li = document.createElement("li");
    li.id = `file-${shown.length}`;
    li.dataset.index = String(shown.length);
    li.setAttribute("role", "option");
    li.title = f.path;
    const slash = f.name.lastIndexOf("/");
    if (f.kind === "table") {
      li.classList.add("table");
      li.append(span("name", `↳ ${f.name.slice(f.name.indexOf("#") + 1)}`), span("dir", ""), span("kind", "table"), span("size", ""));
    } else li.append(span("name", f.name.slice(slash + 1)), span("dir", f.name.slice(0, slash + 1)), span("kind", f.kind), span("size", size(f.size)));
    li.classList.toggle("current", f.path === file?.source || (f.kind === "table" && file?.table !== undefined && f.path === `${file.source}#${file.table}`));
    shown.push(f);
    items.push(li);
  };
  // The connections a database table is opened through come first; choosing one lists its tables.
  for (const c of listed.connections ?? []) {
    const path = `${c.kind}://${c.name}/`;
    const tables = (tablesOpen.get(path) ?? []).filter((t) => words.every((w) => `${c.name}#${t}`.toLowerCase().includes(w)));
    if (!words.every((w) => c.name.toLowerCase().includes(w)) && !tables.length) continue;
    render({ path, name: c.name, kind: "connection", size: 0, modified: 0 });
    for (const t of tables) render({ path: path + t, name: `${c.name}#${t}`, kind: "table", size: 0, modified: 0 });
  }
  for (const { root, files } of listed.roots) {
    // Every listed name ends in an extension, so the extension would match a "q" or a "p" in every file.
    const hits = files.filter((f) => words.every((w) => f.name.toLowerCase().replace(/\.\w+$/, "").includes(w)));
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
    const entries = room.flatMap((f) => [
      f,
      ...(tablesOpen.get(f.path) ?? []).map((t): ListedFile => ({ path: `${f.path}#${t}`, name: `${f.name}#${t}`, kind: "table", size: 0, modified: f.modified })),
    ]);
    for (const f of entries) render(f);
  }
  filesList.replaceChildren(...items);
  active = Math.min(active, Math.max(shown.length - 1, 0));
  highlight();
  const roots = listed.roots.map((r) => r.root).join(", ");
  $("files-note").textContent =
    total === 0 && !shown.length
      ? `No Parquet, CSV, JSON, DuckDB or SQLite files under ${roots}. Type a path above instead.`
      : matched === 0 && !shown.length
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

/**
 * Opens a listed entry. A DuckDB file shows its tables first when it has several (a table of its own is
 * opened as file#table); one with a single table opens directly.
 */
async function openListed(f: ListedFile): Promise<void> {
  if (f.kind !== "connection" && f.kind !== "duckdb" && f.kind !== "sqlite") return open(f.path);
  if (!api) return;
  if (tablesOpen.has(f.path)) {
    tablesOpen.delete(f.path);
    showFiles();
    return;
  }
  say("Reading the tables…");
  let tables: string[];
  try {
    tables = await api.tables(f.path);
  } catch (error) {
    say(openFailed(f.path, error), true);
    return;
  }
  if (f.kind !== "connection" && tables.length === 1) return open(f.path);
  if (!tables.length) return say(`${f.name} has no table to open.`, true);
  tablesOpen.set(f.path, tables);
  showFiles();
  active = Math.min(shown.findIndex((e) => e.path === f.path) + 1, shown.length - 1);
  highlight(true);
  say(`${f.name} has ${tables.length} tables: pick one.`);
}

/** Why a path did not open, with the folders it may be under when the list knows them. */
function openFailed(path: string, error: unknown): string {
  if (!(error instanceof ApiError) || !/^the source is not readable or is outside the allowed roots/.test(error.message)) return describe(error);
  const roots = listed?.roots.map((r) => r.root);
  const where = roots?.length ? `the ${roots.length === 1 ? "folder" : "folders"} fusen-web was started with (${roots.join(", ")})` : "the folders fusen-web may read";
  return `Cannot open ${path}: there is no such file, it cannot be read, or it is outside ${where}.`;
}

async function open(path: string): Promise<void> {
  if (!api) return;
  if (path === "") {
    say("Type the path of a file, or pick one from the list.", true);
    pathInput.focus();
    return;
  }
  say("Opening…");
  try {
    file = await api.open(path);
  } catch (error) {
    say(openFailed(path, error), true);
    return;
  }
  // The rows of the previous file must not be clickable against this one.
  page = undefined;
  rowsTable.replaceChildren();
  ranges = [];
  anchor = undefined;
  cursor = undefined;
  offsets = [];
  filter = undefined;
  hidden = new Set();
  whereInput.value = "";
  whereError.textContent = "";
  whereInput.removeAttribute("aria-invalid");
  seq += 1;
  refInput.value = file.ref;
  latest = Promise.resolve(file.ref);
  pathInput.value = file.table === undefined || file.source.includes("://") ? file.source : `${file.source}#${file.table}`;
  $("hint").hidden = true;
  $("ref-panel").hidden = false;
  showCard(file);
  showSummary();
  showFiles();
  await loadPage(0, 0, undefined, [{ at: 0, index: 0 }]);
  showSelection();
  say(file.selectable ? "" : "Rows of this file cannot be selected: see the note above.");
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
    if (f) void openListed(f);
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
  if (f) void openListed(f);
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
  moveCursor(tr.sectionRowIndex);
  pick(Number(tr.dataset.pos), { shift: event.shiftKey, add: event.ctrlKey || event.metaKey });
});

// The keyboard in the rows: ↑↓ (and Home/End) move and select a row, with Shift they extend the
// range, with Ctrl/⌘ they only move; Space adds or removes the row, Esc selects none, PageDown and
// PageUp turn the page, and Ctrl/⌘+C copies the Ref.
rowsTable.addEventListener("keydown", (event) => {
  if (!file?.selectable || !page?.rows.length) return;
  const add = event.ctrlKey || event.metaKey;
  const last = page.rows.length - 1;
  const to = (index: number) => {
    event.preventDefault();
    moveCursor(index);
    if (!add || event.shiftKey) pick(page!.rows[index]!.pos!, { shift: event.shiftKey, add });
  };
  const here = cursor ?? -1;
  if (event.key === "ArrowDown") to(Math.min(here + 1, last));
  else if (event.key === "ArrowUp") to(Math.max(here - 1, 0));
  else if (event.key === "Home") to(0);
  else if (event.key === "End") to(last);
  else if (event.key === " " && cursor !== undefined) {
    event.preventDefault();
    pick(page.rows[cursor]!.pos!, { shift: false, add: true });
  } else if (event.key === "Escape" && ranges.length) {
    event.preventDefault();
    clearSelection();
  } else if (event.key === "PageDown" || event.key === "PageUp") {
    event.preventDefault();
    $(event.key === "PageDown" ? "next" : "prev").click();
  } else if (add && event.key.toLowerCase() === "c" && !event.shiftKey && !event.altKey && (getSelection()?.isCollapsed ?? true)) {
    // Text selected by hand (a column name, say) copies as usual.
    event.preventDefault();
    copyButton.click();
  }
});

// Coming to the rows by Tab puts the keyboard on the first selected row of the page, or the first row.
rowsTable.addEventListener("focus", () => {
  if (cursor !== undefined || !page?.rows.length) return;
  const at = page.rows.findIndex((r) => r.pos !== null && selected(r.pos));
  moveCursor(Math.max(at, 0));
});

$("clear-selection").addEventListener("click", clearSelection);

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

let copied: ReturnType<typeof setTimeout> | undefined;

/** "Copied ✓" on the button for a moment; it goes as soon as the Ref changes. */
function copyDone(on: boolean): void {
  clearTimeout(copied);
  copyButton.textContent = on ? "Copied ✓" : "Copy";
  copyButton.classList.toggle("done", on);
  if (on) copied = setTimeout(() => copyDone(false), 1500);
}

copyButton.addEventListener("click", async () => {
  const ref = await latest;
  if (ref === undefined) return;
  try {
    await (api?.copy ? api.copy(ref) : navigator.clipboard.writeText(ref));
    if (file) say(`Copied the Ref for ${covers(file)}.`);
    // The button itself answers for a moment, where the click was.
    copyDone(true);
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
  // The keyboard's row goes to the top of the new page, once it is shown.
  void loadPage(at.at, at.index, filter, [...offsets, at]).then((result) => {
    if (result === "shown" && cursor !== undefined) moveCursor(0);
  });
});

$("prev").addEventListener("click", () => {
  if (loading || offsets.length < 2) return;
  const walked = offsets.slice(0, -1);
  const { at, index } = walked.at(-1) ?? { at: 0, index: 0 };
  // Going back, the keyboard's row goes to the bottom of the page before.
  void loadPage(at, index, filter, walked).then((result) => {
    if (result === "shown" && cursor !== undefined && page) moveCursor(page.rows.length - 1);
  });
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
  $("hint").textContent = shown.length
    ? "Pick a file on the left: type to narrow the list, ↑↓ and Enter to open, / to come back to the filter. Or type a path above."
    : "Type the path of a file above and press Enter.";
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
  void openOrChoose(path);
}

/** A DuckDB or SQLite file with several tables lists them to choose from; anything else opens. */
async function openOrChoose(path: string): Promise<void> {
  if (/\.(duckdb|ddb|sqlite|sqlite3|db3)$/i.test(path) && api) {
    try {
      const tables = await api.tables(path);
      if (tables.length > 1) {
        listed = {
          roots: [{ root: path, files: tables.map((t) => ({ path: `${path}#${t}`, name: `${path}#${t}`, kind: "table", size: 0, modified: 0 })), truncated: false }],
          truncated: false,
        };
        $("files-panel").hidden = false;
        showFiles();
        $("hint").textContent = `This database has ${tables.length} tables: pick one on the left.`;
        filterInput.focus();
        return;
      }
    } catch (error) {
      say(describe(error), true);
      return;
    }
  }
  await open(path);
}

// A host that supplies its own Api marks the page (<html data-host>) and calls mount itself.
if (document.documentElement.dataset.host === undefined) void start();
