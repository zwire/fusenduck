import { createElement as h, useCallback, useEffect, useRef, useState, type ReactElement } from "react";
import { useApp } from "ink";
import { View } from "@fusenduck/web/view";
import type { ListedFile } from "@fusenduck/web/files";
import { App, failure } from "./app.ts";
import { Picker } from "./picker.ts";
import { plain } from "./text.ts";

// The screens around the table: the list of files under the roots, and the table of the file opened
// from it. A file named on the command line starts at its table; `b` goes back to the list.

export interface ShellProps {
  roots: string[];
  /** The file given on the command line, already opened. */
  view?: View;
  copy(text: string): void;
  /** Called once when the person quits, with the Ref last shown (undefined when none was made). */
  done(ref: string | undefined): void;
  /** Called with each view the shell opens, so the caller can close it however the program ends. */
  track(view: View): void;
}

export function Shell({ roots, view: given, copy, done, track }: ShellProps): ReactElement {
  const { exit } = useApp();
  const [view, setView] = useState<View | null>(given ?? null);
  const [opening, setOpening] = useState(false);
  const [notice, setNotice] = useState("");
  const gone = useRef(false);
  useEffect(
    () => () => {
      gone.current = true;
    },
    [],
  );

  const open = useCallback(
    (file: ListedFile) => {
      setOpening(true);
      setNotice("");
      View.open(file.path, roots).then(
        (opened) => {
          // The screen went away while the file was opening: nobody will use the view.
          if (gone.current) {
            void opened.close();
            return;
          }
          track(opened);
          setOpening(false);
          setView(opened);
        },
        (error: unknown) => {
          if (gone.current) return;
          setOpening(false);
          setNotice(failure(error, (line) => process.stderr.write(`fusen-tui: ${plain(line)}\n`)));
        },
      );
    },
    [roots, track],
  );

  const back = useCallback(() => {
    // The engine of a file left behind is closed, so a long list session does not hold one per file.
    void view?.close();
    setView(null);
  }, [view]);

  if (view) return h(App, { key: view.opened.source, view, copy, done, back });
  return h(Picker, {
    roots,
    notice,
    opening,
    open,
    quit: () => {
      done(undefined);
      exit();
    },
  });
}
