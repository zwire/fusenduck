import { createElement as h, useCallback, useEffect, useRef, useState, type ReactElement } from "react";
import { Box, Text, useApp, useInput, useWindowSize } from "ink";
import { describeError, FusenError, logLine, SourceChanged } from "@fusenduck/core";
import { MAX_PAGE_ROWS, type Page, type View } from "@fusenduck/web/view";
import { Selection } from "./selection.ts";
import { plain } from "./text.ts";

// The terminal's side of the Web UI (docs/adr/0003): the same View, so the same guards (reads only
// under the roots, a clock on every query, a query stops when its caller goes away, masked card
// bounds, errors worded by core). The screen is a table of one page of rows; rows are picked with
// the keyboard and the Ref for the pick is shown as it changes.

export interface AppProps {
  view: View;
  /** Puts text on the clipboard (OSC 52 on a terminal). */
  copy(text: string): void;
  /** Called once when the person quits, with the Ref last shown (undefined when it could not be made). */
  done(ref: string | undefined): void;
  /** Goes back to the file list; absent when the file was given on the command line with no list to return to. */
  back?: () => void;
}

type RefState = { text: string } | { error: string } | "pending";

const MAX_COLUMN_CHARS = 24;
/** Lines the screen uses besides the rows: header, card, filter, column names, Ref, status, keys. */
const CHROME_LINES = 8;

export const KEYS = "↑↓ move  space pick  v range  esc end range  a clear  / filter  ←→ scroll  c columns  n/p page  y copy  q quit";
const CHOOSER_KEYS = "↑↓ move  space keep/drop  a keep all  enter done  esc done";

const clip = (text: string, width: number) => (text.length > width ? `${text.slice(0, Math.max(0, width - 1))}…` : text);

export function failure(error: unknown, log: (line: string) => void): string {
  if (!(error instanceof FusenError)) log(logLine(error));
  return describeError(error);
}

export function App({ view, copy, done, back }: AppProps): ReactElement {
  const { exit } = useApp();
  const { columns: width, rows: height } = useWindowSize();
  const { opened } = view;
  const names = opened.card.columns.map((c) => plain(c.column));
  const limit = Math.max(3, Math.min(MAX_PAGE_ROWS, height - CHROME_LINES));

  const [page, setPage] = useState<Page | null>(null);
  const [offsets, setOffsets] = useState<number[]>([0]);
  const [where, setWhere] = useState("");
  const [draft, setDraft] = useState<string | null>(null);
  const [cursor, setCursor] = useState(0);
  const [anchor, setAnchor] = useState<number | null>(null);
  const [picked, setPicked] = useState(() => new Selection());
  const [first, setFirst] = useState(0);
  /** The columns the table and the Ref keep, by index in the file's order; null keeps them all. */
  const [kept, setKept] = useState<Set<number> | null>(null);
  /** The cursor of the column chooser while it is open. */
  const [choosing, setChoosing] = useState<number | null>(null);
  const [ref, setRef] = useState<RefState>({ text: opened.ref });
  const [message, setMessage] = useState<string>("");
  const [changed, setChanged] = useState(false);
  const refPromise = useRef<Promise<string | undefined>>(Promise.resolve(opened.ref));
  const quitting = useRef(new AbortController());
  /** The filter whose page loaded last, which a filter that fails goes back to. */
  const goodWhere = useRef("");
  /** The offsets of the page that loaded last, which a page that fails to load goes back to. */
  const goodOffsets = useRef<number[]>([0]);
  /** Set when a failure put the filter back, so the reload that follows keeps the failure's message. */
  const keepMessage = useRef(false);
  const offset = offsets.at(-1) ?? 0;
  const visible = names.map((_, i) => i).filter((i) => kept === null || kept.has(i));
  /** The names the Ref keeps, as the file spells them; undefined keeps every column. */
  const keptKey = kept === null ? undefined : JSON.stringify(opened.card.columns.filter((_, i) => kept.has(i)).map((c) => c.column));

  // stderr is the screen, so a log line is shown as a line of the screen, controls made visible.
  const log = useCallback((line: string) => process.stderr.write(`fusen-tui: ${plain(line)}\n`), []);

  // The page: reloaded when the offset or filter changes; a newer load stops the one in flight.
  useEffect(() => {
    const controller = new AbortController();
    const stop = () => controller.abort();
    quitting.current.signal.addEventListener("abort", stop, { once: true });
    if (keepMessage.current) keepMessage.current = false;
    else setMessage("");
    view
      .rows(opened.fingerprint, offset, limit, where === "" ? undefined : where, controller.signal)
      .then((next) => {
        goodWhere.current = where;
        goodOffsets.current = offsets;
        setPage(next);
        setCursor((c) => Math.min(c, Math.max(0, next.rows.length - 1)));
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        if (error instanceof SourceChanged) setChanged(true);
        setMessage(failure(error, log));
        // A filter that failed must not stay in the box over rows it did not pick.
        if (where !== goodWhere.current) {
          keepMessage.current = true;
          setWhere(goodWhere.current);
          setOffsets([0]);
        } else if (offsets !== goodOffsets.current) {
          // A page that did not load must not leave the table under another page's offset.
          keepMessage.current = true;
          setOffsets(goodOffsets.current);
        }
      });
    return () => {
      controller.abort();
      quitting.current.signal.removeEventListener("abort", stop);
    };
  }, [view, opened.fingerprint, offset, limit, where, log]);

  // The Ref for what is picked: the newest pick's result is the one shown, and Copy waits for it.
  useEffect(() => {
    const controller = new AbortController();
    const stop = () => controller.abort();
    quitting.current.signal.addEventListener("abort", stop, { once: true });
    const ranges = picked.ranges();
    if (ranges.length === 0 && where === "" && keptKey === undefined) {
      setRef({ text: opened.ref });
      refPromise.current = Promise.resolve(opened.ref);
      return () => quitting.current.signal.removeEventListener("abort", stop);
    }
    setRef("pending");
    const made = view
      .ref(opened.fingerprint, ranges, where === "" ? undefined : where, keptKey === undefined ? undefined : JSON.parse(keptKey), controller.signal)
      .then((text) => {
        if (!controller.signal.aborted) setRef({ text });
        return text;
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return undefined;
        if (error instanceof SourceChanged) setChanged(true);
        setRef({ error: failure(error, log) });
        return undefined;
      });
    refPromise.current = made;
    return () => {
      controller.abort();
      quitting.current.signal.removeEventListener("abort", stop);
    };
  }, [view, opened.fingerprint, picked, where, keptKey, opened.ref, log]);

  const quit = useCallback(() => {
    quitting.current.abort();
    // After the file changed, the Ref last shown names rows the file no longer has.
    done(!changed && typeof ref === "object" && "text" in ref ? ref.text : undefined);
    exit();
  }, [done, exit, ref, changed]);

  const rows = page?.rows ?? [];
  const movedTo = (next: number) => {
    const to = Math.max(0, Math.min(next, Math.max(0, rows.length - 1)));
    setCursor(to);
    if (anchor !== null && opened.selectable) {
      const a = rows[anchor]?.pos;
      const b = rows[to]?.pos;
      if (a != null && b != null) {
        const grown = picked.copy();
        grown.addRange(a, b);
        setPicked(grown);
      }
    }
  };
  const goTo = (stack: number[]) => {
    setOffsets(stack);
    setAnchor(null);
    setCursor(0);
  };

  useInput((input, key) => {
    if (key.ctrl && input === "c") {
      quit();
      return;
    }
    if (choosing !== null) {
      if (key.escape || key.return) setChoosing(null);
      else if (key.upArrow || input === "k") setChoosing(Math.max(0, choosing - 1));
      else if (key.downArrow || input === "j") setChoosing(Math.min(names.length - 1, choosing + 1));
      else if (input === "a") setKept(null);
      else if (input === " ") {
        const next = new Set(kept ?? names.map((_, i) => i));
        if (!next.delete(choosing)) next.add(choosing);
        else if (next.size === 0) {
          setMessage("keep at least one column");
          return;
        }
        setKept(next.size === names.length ? null : next);
        setFirst(0);
      }
      return;
    }
    if (draft !== null) {
      if (key.escape) setDraft(null);
      else if (key.return) {
        setDraft(null);
        const next = draft.trim();
        // The Ref ANDs the picked rows with the filter, so picks made under another filter would
        // count rows the Ref no longer returns.
        if (next !== where && picked.size > 0) {
          setPicked(new Selection());
          setMessage("the filter changed, so the picked rows were cleared");
          keepMessage.current = true;
        }
        setWhere(next);
        goTo([0]);
      } else if (key.backspace || key.delete) setDraft(draft.slice(0, -1));
      else if (!key.ctrl && !key.meta && input !== "") setDraft(draft + input.replace(/[\r\n]+/g, " "));
      return;
    }
    if (input === "q") quit();
    else if (input === "b" && back) {
      quitting.current.abort();
      back();
    }
    else if (key.upArrow || input === "k") movedTo(cursor - 1);
    else if (key.downArrow || input === "j") movedTo(cursor + 1);
    else if (key.leftArrow) setFirst((f) => Math.max(0, f - 1));
    else if (key.rightArrow) setFirst((f) => Math.min(Math.max(0, visible.length - 1), f + 1));
    else if (input === "c") {
      setChoosing(0);
      setMessage("");
    }
    else if (input === "n" || key.pageDown) {
      if (page?.next != null) goTo([...offsets, page.next]);
    } else if (input === "p" || key.pageUp) {
      if (offsets.length > 1) goTo(offsets.slice(0, -1));
    } else if (input === "/") setDraft(where);
    else if (input === "a") {
      setPicked(new Selection());
      setAnchor(null);
    } else if (key.escape) setAnchor(null);
    else if (input === " " || input === "v") {
      const pos = rows[cursor]?.pos;
      if (pos == null) {
        setMessage("this file has its own column named file_row_number, so rows cannot be picked");
        return;
      }
      const next = picked.copy();
      if (input === "v") {
        next.addRange(pos, pos);
        setAnchor(cursor);
      } else next.toggle(pos);
      setPicked(next);
    } else if (input === "y") {
      // A pick made while waiting replaces the Ref being made, so wait again for the newest one.
      const newest = async () => {
        let made = refPromise.current;
        let text = await made;
        while (made !== refPromise.current) {
          made = refPromise.current;
          text = await made;
        }
        return text;
      };
      void newest().then((text) => {
        if (text === undefined || changed) {
          setMessage("no Ref to copy");
          return;
        }
        copy(text);
        setMessage("copied the Ref (OSC 52). It is also printed when you quit.");
      });
    }
  });

  // Columns from `first` on, as many as fit.
  const posWidth = String(Math.max(0, opened.card.rows - 1)).length + 3;
  const widths = names.map((name, i) =>
    Math.min(MAX_COLUMN_CHARS, Math.max(name.length, ...rows.map((r) => plain(r.cells[i] ?? "NULL").length))),
  );
  const shown: number[] = [];
  let used = posWidth;
  for (const i of visible.slice(first)) {
    const need = (widths[i] ?? 1) + 2;
    if (shown.length > 0 && used + need > width) break;
    shown.push(i);
    used += need;
  }

  const refLine =
    ref === "pending" ? "Ref: …" : "error" in ref ? `Ref: ${plain(ref.error)}` : `Ref: ${clip(plain(ref.text), Math.max(20, width - 6))}`;
  const filterLine = draft !== null ? `filter> ${plain(draft)}█` : where === "" ? "filter: (none)  press / to type a condition, e.g. amount > 100" : `filter: ${plain(where)}`;
  const count = page === null ? "reading…" : `${page.matched} row${page.matched === 1 ? "" : "s"}${where === "" ? "" : " match"}`;

  if (choosing !== null) {
    // A window of the names that keeps the cursor's line in view.
    const room = Math.max(3, height - 4);
    const start = Math.max(0, Math.min(choosing - Math.floor(room / 2), names.length - room));
    return h(
      Box,
      { flexDirection: "column" },
      h(Text, { bold: true, wrap: "truncate-end" }, `fusen ${plain(opened.source)}: columns`),
      h(Text, { dimColor: true, wrap: "truncate-end" }, `${kept === null ? names.length : kept.size} of ${names.length} kept. The Ref returns only the kept columns.`),
      ...names.slice(start, start + room).map((name, k) => {
        const i = start + k;
        const on = kept === null || kept.has(i);
        return h(Text, { key: i, inverse: i === choosing, wrap: "truncate-end" }, `${on ? "[x]" : "[ ]"} ${clip(name, Math.max(10, width - 6))}`);
      }),
      h(Text, { wrap: "truncate-end" }, plain(message)),
      h(Text, { dimColor: true, wrap: "truncate-end" }, CHOOSER_KEYS),
    );
  }

  return h(
    Box,
    { flexDirection: "column" },
    h(Text, { bold: true, wrap: "truncate-end" }, `fusen ${plain(opened.source)}`),
    h(
      Text,
      { dimColor: true, wrap: "truncate-end" },
      `${opened.card.rows} rows, ${kept === null ? names.length : `${kept.size} of ${names.length}`} columns${opened.card.masked.length > 0 ? `, ${opened.card.masked.length} masked as personal data` : ""} · ${count} · ${picked.size} picked`,
    ),
    h(Text, { wrap: "truncate-end" }, filterLine),
    h(
      Text,
      { bold: true, wrap: "truncate-end" },
      [`${"#".padEnd(posWidth)}`, ...shown.map((i) => clip(names[i] ?? "", widths[i] ?? 1).padEnd(widths[i] ?? 1))].join("  "),
    ),
    ...rows.map((row, r) => {
      const isPicked = row.pos != null && picked.has(row.pos);
      const line = [
        `${r === cursor ? ">" : " "}${isPicked ? "*" : " "}${row.pos === null ? "" : String(row.pos)}`.padEnd(posWidth),
        ...shown.map((i) => clip(plain(row.cells[i] ?? "NULL"), widths[i] ?? 1).padEnd(widths[i] ?? 1)),
      ].join("  ");
      return h(Text, { key: r, inverse: r === cursor, color: isPicked ? "cyan" : undefined, wrap: "truncate-end" }, line);
    }),
    h(Text, { wrap: "truncate-end" }, refLine),
    h(
      Text,
      { color: changed ? "red" : undefined, wrap: "truncate-end" },
      changed ? "the file changed since it was opened. Quit and open it again." : plain(message),
    ),
    h(Text, { dimColor: true, wrap: "truncate-end" }, back ? KEYS.replace("  q quit", "  b files  q quit") : KEYS),
  );
}
