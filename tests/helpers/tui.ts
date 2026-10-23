import { PassThrough } from "node:stream";
import { mount } from "../../apps/tui/src/mount.ts";
import type { View } from "../../apps/web/src/view.ts";

export const KEY = { up: "\u001b[A", down: "\u001b[B", right: "\u001b[C", left: "\u001b[D", enter: "\r", esc: "\u001b", backspace: "\u007f" };

/** The TUI on fake terminal streams. `frame()` is the last screen drawn (debug mode writes whole frames). */
export function driveTui(view: View | null, size = { columns: 100, rows: 24 }, roots: string[] = []) {
  const stdout = Object.assign(new PassThrough(), { ...size, isTTY: true });
  const stdin = Object.assign(new PassThrough(), { isTTY: true, setRawMode() {}, ref() {}, unref() {} });
  let last = "";
  const chunks: string[] = [];
  stdout.on("data", (chunk: Buffer) => {
    const text = chunk.toString();
    chunks.push(text);
    last = text;
  });
  const copied: string[] = [];
  const done: (string | undefined)[] = [];
  /** Views the TUI opened itself from the file list. */
  const tracked: View[] = [];
  const app = mount(
    { roots, ...(view ? { view } : {}), track: (v) => void tracked.push(v), copy: (t) => void copied.push(t), done: (r) => void done.push(r) },
    { stdout: stdout as never, stdin: stdin as never, debug: true, patchConsole: false },
  );
  const frame = () => last;
  async function until(check: (screen: string) => boolean, what: string): Promise<string> {
    for (let i = 0; i < 200; i++) {
      if (check(frame())) return frame();
      await new Promise((r) => setTimeout(r, 25));
    }
    throw new Error(`timed out waiting for ${what}; screen:\n${frame()}`);
  }
  // One chunk per call, and a pause after it: ink reads a chunk as a single key press, so keys
  // written together would be taken as one.
  const press = async (...keys: string[]) => {
    for (const key of keys) {
      stdin.write(key);
      await new Promise((r) => setTimeout(r, 40));
    }
  };
  return { tracked, frame, until, press, copied, done, chunks, stop: () => app.unmount() };
}
