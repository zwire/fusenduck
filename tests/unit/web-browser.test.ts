import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import { describe, expect, it } from "vitest";
import { openBrowser, openerFor } from "../../apps/web/src/browser.ts";

const url = "http://127.0.0.1:4000/#c=AbC-_123";

/** A child that never runs, so the test decides whether it errors or exits. */
function fakeChild(): ChildProcess {
  return Object.assign(new EventEmitter(), { unref: () => {} }) as unknown as ChildProcess;
}

describe("Web UI: opening the browser", () => {
  it("passes the URL as one argument to the platform's opener, never through a shell", () => {
    expect(openerFor(url, "darwin")).toEqual({ command: "open", args: [url] });
    expect(openerFor(url, "win32")).toEqual({ command: "rundll32", args: ["url.dll,FileProtocolHandler", url] });
    expect(openerFor(url, "linux", { DISPLAY: ":0" })).toEqual({ command: "xdg-open", args: [url] });
    expect(openerFor(url, "freebsd", { WAYLAND_DISPLAY: "wayland-0" })).toEqual({ command: "xdg-open", args: [url] });
  });

  it("does not try without a display (SSH, containers)", () => {
    expect(openerFor(url, "linux", {})).toBe("no display");
    const reasons: string[] = [];
    let spawned = false;
    openBrowser(url, { platform: "linux", env: {}, spawn: () => ((spawned = true), fakeChild()), onFail: (r) => reasons.push(r) });
    expect(spawned).toBe(false);
    expect(reasons).toEqual(["no display"]);
  });

  it("reports a missing opener or a failed one once, and stays quiet when it works", () => {
    const run = (act: (child: ChildProcess) => void, platform: NodeJS.Platform = "linux") => {
      const reasons: string[] = [];
      const child = fakeChild();
      openBrowser(url, { platform, env: { DISPLAY: ":0" }, spawn: () => child, onFail: (r) => reasons.push(r) });
      act(child);
      return reasons;
    };
    expect(run((c) => (c.emit("error", new Error("spawn xdg-open ENOENT")), c.emit("exit", null)))).toEqual(["xdg-open: spawn xdg-open ENOENT"]);
    expect(run((c) => c.emit("exit", 3))).toEqual(["xdg-open exited with 3"]);
    expect(run((c) => c.emit("exit", 0))).toEqual([]);
    // rundll32's exit code is not about the browser.
    expect(run((c) => c.emit("exit", 1), "win32")).toEqual([]);
  });
});
