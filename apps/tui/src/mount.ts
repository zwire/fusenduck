import { createElement } from "react";
import { render, type Instance, type RenderOptions } from "ink";
import type { View } from "@fusenduck/web/view";
import { Shell, type ShellProps } from "./shell.ts";

/** Draws the TUI. `options` are ink's (the tests give it fake terminal streams). */
export function mount(props: ShellProps, options: RenderOptions = {}): Instance {
  // The screen goes to stderr, so a pipe on stdout carries only the Ref printed on quit.
  return render(createElement(Shell, props), { exitOnCtrlC: false, stdout: process.stderr, ...options });
}

export type { ShellProps, View };
