// The agents' hook settings and where the rails live: which files run or switch off the hooks,
// and whether an edit of one drops this skill's hooks. Shared by the hook checks.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const norm = (t) => t.replace(/\\/g, "/").toLowerCase();

// The rails' own definition: the skill (playbooks, profile, these scripts) and the agents' hook
// settings. They change only while the human has suspended the rails, so the agent cannot switch
// its own rails off (rails: advisory, a deleted guard, a removed hook, disableAllHooks).
// Files whose settings run or switch off the hooks: Claude Code's (which Copilot reads too), Codex's
// and Copilot's own settings (they can hold hooks and disableAllHooks). VS Code's settings can turn
// hooks off too (chat.useHooks) but are read often, so code that merely names them is not refused.
export const HOOK_CONFIGS = [".claude/settings.json", ".claude/settings.local.json", ".codex/hooks.json", ".codex/config.toml", ".github/copilot/settings.json", ".github/copilot/settings.local.json"];
export function railsPaths(root, skillDir) {
  const configs = [...HOOK_CONFIGS, ".vscode/settings.json", `.github/hooks/${path.basename(skillDir)}.json`].map((f) => path.join(root, f));
  configs.push(...[".claude/settings.json", ".codex/config.toml", ".copilot/settings.json"].map((f) => path.join(os.homedir(), f)));
  // Copilot runs every file in .github/hooks/, so a new one is a new hook.
  return { skill: skillDir, configs, state: path.join(root, ".flow"), hookDir: path.join(root, ".github", "hooks") };
}
// Paths compared as the most permissive file system would: any case, either slash.
export const samePath = (a, b) => norm(a) === norm(b);
export const inside = (p, dir) => samePath(p, dir) || norm(p).startsWith(norm(dir).replace(/\/$/, "") + "/");
// Hook settings may change except where an edit drops a flow.mjs hook or turns hooks off.
export const DISABLES_HOOKS = /disableAllHooks|codex_hooks\s*=\s*false|chat\.useHooks["']?\s*[:=]\s*false/i;
// Codex: hooks = false under [features] (or features.hooks = false).
const TOML_OFF = /\bhooks\s*=\s*false\b/;

// Whether an edit of a hook settings file changes what the hooks run: removes a flow.mjs hook,
// turns hooks off, points the agent at other hook files, or adds a command. A command the agent
// adds would run at the next lifecycle event, outside the tool hook, where it could write the run
// state or answer a gate. Other settings (permissions, models, editor options) may change.
export function dropsHooks(abs, act) {
  const { removed, added, whole } = act.change;
  const off = (t) => DISABLES_HOOKS.test(t) || HOOK_FILES_SETTING.test(t) || (/\.toml$/i.test(abs) && TOML_OFF.test(t));
  if (off(added) || off(whole ?? "")) return true;
  // A hook command taken out must come back in the same edit: re-indenting or editing next to it is fine.
  const hookCommands = (t) => [...t.matchAll(/[^"'\n]*(?<![\w-])flow\.mjs[^"'\n]*/g)].map((m) => m[0].trim());
  if (hookCommands(removed).some((c) => !added.includes(c))) return true;
  if (commands(added).some((c) => !commands(removed).includes(c))) return true;
  if (whole === undefined) return false;
  let before = "";
  try { before = fs.readFileSync(abs, "utf8"); } catch {}
  return hookCommands(before).some((c) => !whole.includes(c)) || commands(whole).some((c) => !commands(before).includes(c));
}
// The commands a settings file runs: values of `command` keys (JSON and TOML), and argument lists.
const commands = (t) => [...String(t).matchAll(/["']?\b(?:command|bash|powershell|args)["']?\s*[:=]\s*("(?:[^"\\]|\\.)*"|'[^']*'|\[[^\]]*\])/g)].map((m) => m[1]);
// VS Code loads hook files from the folders this setting lists.
const HOOK_FILES_SETTING = /hookFilesLocations/i;
