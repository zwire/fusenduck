// Where the runtime is and which skill it serves, and the small helpers every part of it shares.
// Environment: FLOW_SKILL (skill directory; default: the parent of scripts/).

import path from "node:path";
import { fileURLToPath } from "node:url";

// The skill's scripts/ folder, which holds flow.mjs.
export const here = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const skillDir = path.resolve(process.env.FLOW_SKILL || path.join(here, ".."));
export const skillName = path.basename(skillDir);
export const tag = `[${skillName}]`;
export const now = () => new Date().toISOString();
export const RESOLVED = new Set(["done", "skipped", "rejected"]);

// A refusal: the message goes to the agent, the code is the command's exit code
// (1 refused by the graph, 2 usage, 3 interrupted for the human).
export class Stop extends Error {
  constructor(message, code = 1) { super(message); this.code = code; }
}
export const refuse = (msg) => { throw new Stop(msg, 1); };
// A path relative to the project root, with forward slashes on every platform.
export const relPath = (root, p) => path.relative(root, p).split(path.sep).join("/");
export const railsLevel = (g) => g.profile.rails || "standard";

// How the agent runs flow.mjs from the project root.
export const flowCmd = (root) => {
  const rel = relPath(root, path.join(here, "flow.mjs"));
  return `node ${rel.startsWith("..") ? path.join(here, "flow.mjs") : rel}`;
};
