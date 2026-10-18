// Installing the hooks (and, on request, the MCP server) for Claude Code, Codex and GitHub Copilot,
// plus a skeleton of the project's bindings.

import fs from "node:fs";
import path from "node:path";
import { here, skillName, Stop, refuse, relPath } from "./env.mjs";
import { projectFile } from "./bindings.mjs";
import { loadGraph } from "./graph.mjs";

// The runtime is the same for every agent; only the configuration files differ. Each one runs
// hook commands with a JSON payload on stdin and reads a JSON deny on stdout.
// The files are not private to one agent: Copilot CLI (and VS Code's Copilot) also runs the hooks in
// .claude/settings*.json, without CLAUDE_PROJECT_DIR, and Claude Code and Codex run hooks from
// wherever the agent is, which may be a subfolder. So the Claude and Codex commands find flow.mjs
// from the root that node prints (CLAUDE_PROJECT_DIR when Claude Code set it, else git's, else the
// current folder), which reads the same in sh, bash and PowerShell. Copilot's own file runs from the
// root (cwd ".").
const ROOT = `$(node -p "process.env.CLAUDE_PROJECT_DIR||(require('child_process').spawnSync('git',['rev-parse','--show-toplevel'],{encoding:'utf8'}).stdout||'').trim()||'.'")`;

const EVENTS = { "session-start": "SessionStart", "user-prompt": "UserPromptSubmit", "pre-tool-use": "PreToolUse", stop: "Stop" };

const HARNESSES = {
  claude: {
    hooks: (scope) => (scope === "local" ? ".claude/settings.local.json" : ".claude/settings.json"),
    fromRoot: true,
    entry: (command) => ({ hooks: [{ type: "command", command }] }),
    // The user's pick in an AskUserQuestion dialog answers a gate (lib/ask.mjs); only that tool.
    extra: { "post-tool-use": ["PostToolUse", "AskUserQuestion"] },
    mcp: { file: ".mcp.json", format: "json" },
  },
  codex: {
    hooks: () => ".codex/hooks.json",
    fromRoot: true,
    entry: (command) => ({ hooks: [{ type: "command", command }] }),
    mcp: { file: ".codex/config.toml", format: "toml" },
    note: "Codex runs project hooks once the project is trusted and you have reviewed the hooks with /hooks.",
  },
  // Copilot CLI, cloud agent and VS Code all read .github/hooks/*.json. PascalCase event names
  // select the snake_case payload the hook reads; --agent copilot shapes the output (see runHook).
  copilot: {
    hooks: () => `.github/hooks/${skillName}.json`,
    entry: (command) => ({ type: "command", command, cwd: "." }),
    version: 1,
    note: "Copilot CLI runs repository hooks only in a folder you have trusted, and ignores UserPromptSubmit output, so run state is injected only at session start; chat approvals are still recorded.",
  },
};

function readJson(file) {
  if (!fs.existsSync(file)) return {};
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { refuse(`${file} is not valid JSON; fix it first`); }
}

export function install(root, o) {
  const names = String(o.harness || "").split(",").map((x) => x.trim()).filter(Boolean);
  if (!names.length || names.some((n) => !HARNESSES[n])) throw new Stop(`--harness must list one or more of: ${Object.keys(HARNESSES).join(", ")}`, 2);
  const scope = o.scope || "project";
  if (!["project", "local"].includes(scope)) throw new Stop("--scope must be project or local", 2);
  const script = path.join(here, "flow.mjs");
  const rel = relPath(root, script);
  const inRoot = !rel.startsWith("..") && !path.isAbsolute(rel);
  const writes = new Map();
  const report = [];
  const load = (file) => (writes.has(file) ? writes.get(file) : readJson(path.join(root, file)));

  // This skill's hook commands in any form an earlier install wrote; they are replaced, not added to.
  const ours = (c) => typeof c === "string" && /flow\.mjs["']?\s+hook\s/.test(c) && (c.includes(rel) || c.includes(script));

  for (const name of names) {
    const h = HARNESSES[name];
    const target = !inRoot ? JSON.stringify(script) : h.fromRoot ? `"${ROOT}/${rel}"` : JSON.stringify(rel);
    const file = h.hooks(scope);
    const cfg = load(file);
    if (h.version) cfg.version ||= h.version;
    const events = (cfg.hooks ||= {});
    const changed = [];
    for (const [ev, [native, matcher]] of [...Object.entries(EVENTS).map(([e, n]) => [e, [n]]), ...Object.entries(h.extra || {})]) {
      const entry = { ...(matcher ? { matcher } : {}), ...h.entry(`node ${target} hook ${ev} --agent ${name}`) };
      const before = JSON.stringify(events[native] || []);
      const list = (events[native] || [])
        .map((x) => (x.hooks ? { ...x, hooks: x.hooks.filter((y) => !ours(y.command)) } : x))
        .filter((x) => !ours(x.command) && !(x.hooks && !x.hooks.length));
      list.push(entry);
      events[native] = list;
      if (!before.includes(JSON.stringify(entry))) changed.push(native);
    }
    writes.set(file, cfg);
    report.push(`${name}: ${changed.length ? `hooks ${changed.join(", ")} written` : "hooks already present"} in ${file}${h.note ? ` (${h.note})` : ""}`);

    // MCP is opt-in: tool schemas cost context in every session, and only elicitation adds
    // something the CLI and hooks do not.
    if (!o.mcp) continue;
    if (!h.mcp) { report.push(`${name}: MCP registration is not automated; register \`node ${inRoot ? rel : script} mcp\` in its MCP settings by hand`); continue; }
    const server = { command: "node", args: [inRoot ? rel : script, "mcp"] };
    if (h.mcp.format === "json") {
      const m = load(h.mcp.file);
      m.mcpServers ||= {};
      const fresh = !m.mcpServers[skillName];
      m.mcpServers[skillName] ||= server;
      writes.set(h.mcp.file, m);
      report.push(`${name}: MCP server "${skillName}" ${fresh ? "registered" : "already registered"} in ${h.mcp.file}`);
    } else {
      const file = path.join(root, h.mcp.file);
      const text = writes.get(h.mcp.file) ?? (fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "");
      const header = `[mcp_servers.${JSON.stringify(skillName)}]`;
      const fresh = !text.includes(header);
      writes.set(h.mcp.file, fresh ? `${text}${text && !text.endsWith("\n") ? "\n" : ""}\n${header}\ncommand = "node"\nargs = ${JSON.stringify(server.args)}\n` : text);
      report.push(`${name}: MCP server "${skillName}" ${fresh ? "registered" : "already registered"} in ${h.mcp.file}`);
    }
  }

  // The project's values for the skill's bindings: a skeleton the user fills in, never overwritten.
  const proj = relPath(root, projectFile(root, skillName));
  const declared = Object.entries(loadGraph(root).bindings);
  if (declared.length && !fs.existsSync(path.join(root, proj))) {
    writes.set(proj, [
      "---",
      `# Values of ${skillName}'s bindings for this repository (see the skill's bindings.md).`,
      "# A value is a string, or a list [a, b] for several globs or commands. Empty means unbound.",
      ...declared.flatMap(([k, d]) => [`# ${d}`, `${k}: ""`]),
      "---",
      "",
      "# Project notes",
      "",
      "Facts about this repository the workflow relies on: toolchain, where data and artifacts live, who approves what.",
      "",
    ].join("\n"));
    report.push(`project: wrote ${proj}; fill in every value before the first run`);
  }

  const out = [];
  for (const [file, content] of writes) {
    const text = typeof content === "string" ? content : JSON.stringify(content, null, 2) + "\n";
    if (o["dry-run"]) out.push(`--- ${file}\n${text}`);
    else { fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true }); fs.writeFileSync(path.join(root, file), text); }
  }
  if (o["dry-run"]) return out.join("\n");
  return `${report.join("\n")}\nRun state lives in .flow/${skillName}/. Commit ${proj}; commit the rest for an audit trail, or ignore .flow/*/state.json, .flow/*/log.jsonl and .flow/*/runs/.`;
}
