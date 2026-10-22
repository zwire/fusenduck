// Opening the printed URL in the default browser. The URL goes to the opener as its own argument,
// never through a shell, and it carries only the one-time code: the opener's and the browser's
// arguments can be read by other users of the machine (docs/adr/0002).
import { spawn as nodeSpawn, type ChildProcess } from "node:child_process";

export interface Opener {
  command: string;
  args: string[];
}

/** The platform's opener for `url`, or a reason there is none. */
export function openerFor(url: string, platform: NodeJS.Platform = process.platform, env: NodeJS.ProcessEnv = process.env): Opener | string {
  switch (platform) {
    case "darwin":
      return { command: "open", args: [url] };
    case "win32":
      // Not `cmd /c start`: cmd would parse the URL. rundll32 takes it as one argument.
      return { command: "rundll32", args: ["url.dll,FileProtocolHandler", url] };
    default:
      // Over SSH or in a container there is nothing to open a browser on.
      if (!env.DISPLAY && !env.WAYLAND_DISPLAY) return "no display";
      return { command: "xdg-open", args: [url] };
  }
}

export interface OpenOptions {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  /** Starts the opener; tests replace it. */
  spawn?: (command: string, args: string[]) => ChildProcess;
  /** Called once if the browser could not be opened, with the reason. */
  onFail: (reason: string) => void;
}

const detached = (command: string, args: string[]) => nodeSpawn(command, args, { stdio: "ignore", detached: true, windowsHide: true });

/** Starts the opener and returns without waiting for it; failures are reported through `onFail`. */
export function openBrowser(url: string, options: OpenOptions): void {
  const opener = openerFor(url, options.platform, options.env);
  if (typeof opener === "string") return options.onFail(opener);
  let child: ChildProcess;
  try {
    child = (options.spawn ?? detached)(opener.command, opener.args);
  } catch (error) {
    return options.onFail(error instanceof Error ? error.message : String(error));
  }
  let failed = false;
  const fail = (reason: string) => {
    if (failed) return;
    failed = true;
    options.onFail(reason);
  };
  child.once("error", (error) => fail(`${opener.command}: ${error.message}`));
  // rundll32's exit code says nothing about the browser, so only the others are read.
  child.once("exit", (code) => {
    if (opener.command !== "rundll32" && code !== null && code !== 0) fail(`${opener.command} exited with ${code}`);
  });
  child.unref();
}
