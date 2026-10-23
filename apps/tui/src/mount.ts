import { createElement } from "react";
import { render, type Instance, type RenderOptions } from "ink";
import type { View } from "@fusenduck/web/view";
import { App, type AppProps } from "./app.ts";

/** Draws the TUI for `view`. `options` are ink's (the tests give it fake terminal streams). */
export function mount(props: AppProps, options: RenderOptions = {}): Instance {
  return render(createElement(App, props), { exitOnCtrlC: false, ...options });
}

export type { AppProps, View };
