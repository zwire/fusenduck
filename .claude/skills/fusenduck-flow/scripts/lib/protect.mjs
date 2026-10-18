// What the agent may not touch: the run state in .flow/, the rails (the skill and the agents' hook
// settings) and the commands only the human may run. Part of the security boundary of the rails:
// every check here fails closed when unsure.

import os from "node:os";
import path from "node:path";
import { shellCommands, programName, commandStart } from "./shell.mjs";
import { HOOK_CONFIGS, DISABLES_HOOKS, railsPaths, inside, samePath } from "./settings.mjs";

// Whether code for an interpreter names the run state or the rails: any mention counts, as it
// can open any path. ctx = { root, skillDir }.
export function codeTouchesRails(text, ctx) {
  const t = norm(text);
  const rel = norm(path.relative(ctx.root, ctx.skillDir));
  return /\.flow/.test(t) || namesRuntime(text, ctx) || (rel !== "" && t.includes(rel)) || HOOK_CONFIGS.some((f) => t.includes(f)) || DISABLES_HOOKS.test(text);
}

// Whether text names the runtime's code: flow.mjs (not workflow.mjs; a POSIX shell reads
// scripts\flow.mjs as scriptsflow.mjs), or a module in the skill's scripts/lib/ (which can write the
// run state or answer a gate when loaded). The skill may sit outside the project, so its name is
// matched, not its path. ctx = { skillDir }, optional.
function namesRuntime(text, ctx) {
  const t = norm(text).replace(/\/(\.\/)+/g, "/").replace(/\/{2,}/g, "/");
  return /(?<![\w-])flow\.mjs|scripts\/?flow\.mjs/.test(t) || (!!ctx?.skillDir && t.includes(`${norm(path.basename(ctx.skillDir))}/scripts/lib/`));
}

// ---------- shell access to the run state and to the human-only commands ----------
// Reading .flow/ is harmless (the Read tool may do it too); changing it, or running the commands
// only the human may run, must not happen from the agent's shell. Checked on every reading of
// the line (POSIX shell, and PowerShell where it may run), any case, either slash.
const STATE_PATH = /(^|[/=:,])\.flow(\/|$)/;
const norm = (t) => t.replace(/\\/g, "/").toLowerCase();
const mentionsState = (t) => /\.flow/i.test(t);

// A glob segment that could expand to .flow: `.f*`, `.fl?w`, and in PowerShell a bare `*`
// (its wildcards match dotfiles).
function globHitsState(seg, ps) {
  if (!/[*?[]/.test(seg) || (!ps && !seg.startsWith("."))) return false;
  let re = "";
  for (let i = 0; i < seg.length; i++) {
    const c = seg[i];
    if (c === "*") re += ".*";
    else if (c === "?") re += ".";
    else if (c === "[") { const e = seg.indexOf("]", i + 1); if (e < 0) re += "\\["; else { re += `[${seg.slice(i + 1, e).replace(/^!/, "^").replace(/\\/g, "\\\\")}]`; i = e; } }
    else re += c.replace(/[.+^${}()|\\]/g, "\\$&");
  }
  try { return new RegExp(`^${re}$`).test(".flow"); } catch { return true; }
}
// A word that names .flow, or a glob that could expand to it. A dotted glob (`.f*`) counts wherever
// it sits; PowerShell's bare `*` only where it lists the project root itself, so
// `Remove-Item build\* -Recurse` does not count. ctx = { root, cwd } resolves a prefix like `..\proj`.
function isStateWord(t, ps, ctx) {
  const n = norm(t);
  if (STATE_PATH.test(n)) return true;
  return n.replace(/^-[a-z]+:/, "").split(/[=,]/).some((part) => {
    const segs = part.split("/");
    return segs.some((seg, i) => {
      if (!globHitsState(seg, ps)) return false;
      if (seg.startsWith(".")) return true;
      const prefix = segs.slice(0, i).join("/");
      return prefix === "" || prefix === "." || (!!ctx && samePath(path.resolve(ctx.cwd, prefix), ctx.root));
    });
  });
}
// A plain path argument, as opposed to an option value, a script or a sentence.
const purePath = (t) => !/^-/.test(t) && !/\s/.test(t) && STATE_PATH.test(norm(t));
// A redirection that writes its path (`>`, `>>`, `&>`, `<>`); `<` only reads it.
const writesTo = (x) => typeof x.redir === "string" && x.redir.includes(">");
// Changing directory only moves where later paths resolve; shellViolation follows it.
const CHDIR = /^(cd|pushd|chdir|set-location|sl|push-location)$/;

// Programs that delete, empty or move the paths they are given.
const DELETERS = /^(rm|rmdir|unlink|shred|mv|move|ren|remove-item|ri|del|erase|rd|move-item|mi|rename-item|rni|clear-content|clc)$/;
// Programs that only read the files they are given, with the flags that make them write or run code.
const READERS = new Map(Object.entries({
  cat: null, head: null, tail: null, less: /^(-o|-O|--log-file|--LOG-FILE)/, more: null, ls: null, wc: null, grep: null, egrep: null, fgrep: null,
  rg: /^--pre/, jq: null, stat: null, file: null, diff: null, cmp: null, tree: null, du: null, sort: /^(-o|--output)/, uniq: null, cut: null,
  column: null, od: null, xxd: null, hexdump: null, strings: null, md5sum: null, sha1sum: null, sha256sum: null, shasum: null, type: null,
  find: /^-(delete|exec|execdir|ok|okdir|fprint|fprint0|fprintf|fls)$/, sed: /^(-i|--in-place|-I)/, awk: /^(-i|--in-place)/, gawk: /^(-i|--in-place)/,
  dir: null, findstr: null, "get-content": null, gc: null, "get-childitem": null, gci: null, "select-string": null, sls: null, "test-path": null,
  "get-item": null, gi: null, "get-itemproperty": null, gp: null, "resolve-path": null, rvpa: null, "format-hex": null, fhx: null, "get-filehash": null,
}));
// These take a script that could write, so a .flow mention outside a plain path argument counts as a write.
const SCRIPTED = new Set(["sed", "awk", "gawk", "less"]);
const OUTPUT_FLAG = /^(-o|--output|--output-file|--log-file|-outfile)$/i;
const GIT_READS = new Set(["add", "commit", "log", "show", "diff", "status", "blame", "ls-files", "ls-tree", "grep", "cat-file", "check-ignore", "rev-parse", "describe", "shortlog"]);
const INTERPRETERS = /^(python\d*(\.\d+)?|node|nodejs|deno|bun|ruby|perl|php|osascript|lua|tclsh)$/;
// `unsuspend` only turns the rails back on, so the agent may run it; `request suspend` only asks, and
// `answer` records an answer the user has sent (flow.mjs checks it against their messages).
const HUMAN_ONLY = new Set(["approve", "reject", "suspend", "hook", "mcp"]);

// The program a simple command runs and its arguments, past assignments and wrappers like sudo.
function head(w) {
  const k = commandStart(w);
  return { k, name: programName(w[k].text), args: w.slice(k + 1) };
}
// The first argument that is not a flag: git's subcommand.
const subcommand = (args) => args.find((x) => !/^-/.test(x.text))?.text;
// A reader with no flag that could make it write or run code.
const pureReader = (name) => READERS.has(name) && !READERS.get(name);
// git subcommands that leave the working tree alone (`git rm --cached` only changes the index).
const gitReads = (args) => GIT_READS.has(subcommand(args)) || (subcommand(args) === "rm" && args.some((x) => x.text === "--cached"));
// Programs whose arguments are text, not files: only their redirections write.
const DATA_PROGRAMS = new Set(["echo", "printf", "write-output", "write-host"]);
// Option values that leave a path out (`--exclude=.flow`, `--exclude-dir .flow`): naming .flow
// there keeps it untouched. Programs that delete or move do not get this.
const EXCLUDE_EQ = /^--?[\w-]*(exclude|ignore)[\w-]*=/i;
const EXCLUDE_FLAG = /^--(exclude|exclude-dir|ignore|ignore-pattern|ignore-path)$/i;
// git also takes `-e <pattern>` (git clean, git ls-files).
const excluded = (args, j, git) => EXCLUDE_EQ.test(args[j].text) || EXCLUDE_FLAG.test(args[j - 1]?.text || "") || (git && (/^-e./.test(args[j].text) || args[j - 1]?.text === "-e"));
const withoutExcluded = (args, git = false) => args.filter((x, j) => !excluded(args, j, git));
// PowerShell cmdlets that write text to a path: only the path counts (`-Path`, `-LiteralPath`,
// `-FilePath`, `-Name`, or the first operand), never the text (`Add-Content .gitignore ".flow/x"`).
// Empty when the path is not given, so it comes from the pipeline.
const CONTENT_WRITERS = /^(set-content|sc|add-content|ac|out-file|new-item|ni)$/;
const PATH_PARAM = /^-(path|literalpath|lp|pspath|filepath|name)(:|$)/i;
const SWITCH = /^-(force|nonewline|passthru|append|whatif|confirm|noclobber|asbytestream|recurse)$/i;
// A link's target is a path too: `New-Item -ItemType SymbolicLink -Path x -Target .flow`.
const LINK_PARAM = /^-(target|value)(:|$)/i;
function contentTargets(args) {
  const out = [];
  const link = args.some((x, j) => /^-(itemtype|type)(:.*)?$/i.test(x.text) && /link|junction/i.test(/:/.test(x.text) ? x.text : args[j + 1]?.text || ""));
  for (const [j, x] of args.entries()) if (PATH_PARAM.test(x.text) || (link && LINK_PARAM.test(x.text))) { const v = /:/.test(x.text) ? x : args[j + 1]; if (v) out.push(v); }
  const first = args.find((x, j) => !/^-/.test(x.text) && !(/^-/.test(args[j - 1]?.text || "") && !SWITCH.test(args[j - 1].text)));
  if (first && !out.includes(first)) out.push(first);
  return out;
}
// Copying only writes its destination: the last operand, or the value of -t / -Destination.
// undefined when the program does not copy, null when the destination cannot be told.
function copyDestination(name, args) {
  if (/^(copy-item|cpi|copy)$/.test(name)) {
    const at = args.findIndex((x) => /^-d(e(s(t(i(n(a(t(i(o(n)?)?)?)?)?)?)?)?)?)?$/i.test(x.text));
    return at >= 0 ? args[at + 1] ?? null : args.filter((x) => !/^-/.test(x.text)).pop() ?? null;
  }
  if (!/^(cp|rsync|scp)$/.test(name)) return undefined;
  if (args.some((x) => /^(-t|--target-directory)/.test(x.text))) return null;
  return args.filter((x) => !/^-/.test(x.text)).pop() ?? null;
}

// ---------- prompts the agent could put in the human's place ----------
// While a question waits for the user, their answer is the next message they send (reply.mjs), so
// the agent may not hand a prompt to another agent session it starts: that session's hooks are this
// skill's, and its prompt would be kept as the user's.
const AGENT_CLIS = new Set(["claude", "codex", "copilot"]);
const RUNNERS = new Set(["timeout", "gtimeout", "xargs", "setsid", "stdbuf", "unbuffer", "caffeinate", "npx", "bunx", "pnpx"]);
const AGENT_PACKAGE = /(^|[/@\\])(anthropic-ai[/\\]claude-code|openai[/\\]codex|github[/\\]copilot)([@/\\]|$)/i;

// Whether a simple command starts an agent session with a prompt: an argument that is not a flag,
// or stdin from a pipe, a heredoc or a file. `claude --version` starts none.
function nestedAgent(w) {
  const { k, name } = head(w);
  // The program, or the one a runner starts (`timeout 60 claude ...`, `xargs claude ...`).
  const run = RUNNERS.has(name) ? w.findIndex((x, j) => j > k && !/^-/.test(x.text) && !/^\d+[smhd]?$/.test(x.text)) : k;
  const at = run >= 0 && AGENT_CLIS.has(programName(w[run].text)) ? run : w.findIndex((x, j) => j >= k && AGENT_PACKAGE.test(x.text));
  if (at < 0) return false;
  const args = w.slice(at + 1);
  if (w.piped || w.fed || args.some((x) => typeof x.redir === "string" && x.redir.startsWith("<"))) return true;
  return args.some((x) => !x.redir && !/^-/.test(x.text));
}

function commandViolation(w, ctx) {
  const { name, args: all } = head(w);
  if (ctx?.waiting && nestedAgent(w)) return "agent";
  if (CHDIR.test(name)) return null;
  const args = all.filter((x) => !x.redir);
  const flowAt = w.findIndex((x) => programName(x.text) === "flow.mjs");
  if (flowAt >= 0 && !["request", "answer"].includes(w[flowAt + 1]?.text) && w.slice(flowAt + 1).some((x) => HUMAN_ONLY.has(x.text.toLowerCase()))) return "human";
  // Code that loads the runtime itself could call approve() or answer a gate.
  if (INTERPRETERS.test(name) && all.some((x) => namesRuntime(x.text, ctx) && programName(x.text) !== "flow.mjs")) return "human";
  // git clean -x deletes ignored files, .flow/ among them, unless it dry-runs or excludes .flow (-e .flow).
  if (name === "git" && subcommand(args) === "clean") {
    if (args.some((x, j) => /(^|[=e])\.?\/?\.flow\/?$/.test(x.text) && excluded(args, j, true))) return null;
    if (args.some((x) => /^-[a-z]*[xX]/.test(x.text)) && !args.some((x) => /^(-[a-z]*n|--dry-run)$/.test(x.text))) return "clean";
  }
  if (w.some((x) => writesTo(x) && isStateWord(x.text, w.ps, ctx))) return "state";
  if (DATA_PROGRAMS.has(name)) return null;
  // Interpreter code can open any path, so any mention of .flow in its arguments counts.
  if (INTERPRETERS.test(name)) return args.some((x) => mentionsState(x.text)) ? "state" : null;
  const dest = copyDestination(name, args);
  if (dest !== undefined) {
    // Copying out of .flow/ only reads it; the destination must not be in it.
    if (!dest || isStateWord(dest.text, w.ps, ctx)) return args.some((x) => isStateWord(x.text, w.ps, ctx)) ? "state" : null;
    return args.some((x) => x !== dest && mentionsState(x.text) && STATE_PATH.test(norm(x.text)) && !purePath(x.text.replace(/^-(path|literalpath|lp):/i, ""))) ? "state" : null;
  }
  const deletes = DELETERS.test(name);
  const content = w.ps && CONTENT_WRITERS.test(name) ? contentTargets(args) : [];
  if (content.length) return content.some((x) => isStateWord(x.text, w.ps, ctx)) ? "state" : null;
  const targets = deletes ? args : withoutExcluded(args, name === "git");
  const reader = READERS.has(name) ? READERS.get(name) : name === "git" && gitReads(args) ? /^--output/ : undefined;
  if (reader === undefined) return targets.some((x) => isStateWord(x.text, w.ps && deletes, ctx)) ? "state" : null;
  if (!targets.some((x) => mentionsState(x.text))) return null;
  if (reader && args.some((x) => reader.test(x.text))) return "state";
  for (const [j, x] of args.entries()) {
    if (!targets.includes(x)) continue;
    if (!mentionsState(x.text)) continue;
    const value = x.text.replace(/^-(path|literalpath|lp):/i, "");
    if (STATE_PATH.test(norm(value)) && (!purePath(value) || OUTPUT_FLAG.test(args[j - 1]?.text || ""))) return "state";
    if (SCRIPTED.has(name) && !purePath(value)) return "state";
  }
  return null;
}


// Text that names the skill or a hook settings file, or turns the hooks off: code that could rewrite them.
const namesRails = (t, rel) => (rel !== "" && norm(t).includes(rel)) || HOOK_CONFIGS.some((f) => norm(t).includes(f)) || DISABLES_HOOKS.test(t);

function railsViolation(w, ctx) {
  const { k, name, args: all } = head(w);
  if (CHDIR.test(name)) return null;
  const rp = railsPaths(ctx.root, ctx.skillDir);
  const rel = norm(path.relative(ctx.root, rp.skill));
  const resolve = (t) => path.resolve(ctx.cwd, t.replace(/^-[a-z]+:/i, "").replace(/^~(?=\/|\\|$)/, os.homedir()));
  // What a path is: in the run state (named by a path that resolves there, as after a cd), or in the rails.
  const hit = (t) => {
    const p = resolve(t);
    return inside(p, rp.state) ? "state" : inside(p, rp.skill) || rp.configs.some((q) => samePath(q, p)) || inside(p, rp.hookDir) ? "rails" : null;
  };
  // A redirection writes its path whatever the program is (`cat x > .claude/settings.json`).
  for (const x of all) if (writesTo(x) && hit(x.text)) return hit(x.text);
  const args = all.filter((x) => !x.redir);
  // Deleting or moving a directory that holds the state or the rails.
  if (DELETERS.test(name)) {
    for (const x of args) {
      if (/^-/.test(x.text) || /[*?[]/.test(x.text)) continue;
      const p = resolve(x.text);
      if ([rp.state, rp.skill, ...rp.configs].some((q) => inside(q, p))) return inside(rp.state, p) && !inside(rp.skill, p) ? "state" : "rails";
    }
  }
  // A reader with no flag that makes it write; a sed or awk script may still name a file to write.
  const flag = READERS.get(name);
  if (READERS.has(name) && !(flag && args.some((x) => flag.test(x.text)))) return SCRIPTED.has(name) && args.some((x) => /\s|;/.test(x.text) && namesRails(x.text, rel)) ? "rails" : null;
  if (name === "git" && gitReads(args)) return null;
  // Interpreter code (not the script it runs) that names the rails could rewrite them.
  if (INTERPRETERS.test(name)) return args.some((x) => /\s|[(;]/.test(x.text) && namesRails(x.text, rel)) ? "rails" : null;
  const dest = copyDestination(name, args);
  const content = w.ps && CONTENT_WRITERS.test(name) ? contentTargets(args) : [];
  const named = DATA_PROGRAMS.has(name) ? [] : dest ? [dest] : content.length ? content : DELETERS.test(name) ? args : withoutExcluded(args, name === "git");
  for (const x of [...named, ...w.slice(0, k)]) {
    if (programName(x.text) === "flow.mjs" || /\s/.test(x.text) || (/^-/.test(x.text) && !/^-[a-z]+:/i.test(x.text))) continue;
    if (hit(x.text)) return hit(x.text);
  }
  return null;
}

// Commands that change whatever is piped into them (`find .flow | xargs rm`, `gci .flow | Remove-Item`).
// A content cmdlet given its own path writes the piped text there; tee and Copy-Item only write
// their own target, which the command's own check covers.
const pipeWrites = (name) => /^(xargs|parallel)$/.test(name) || DELETERS.test(name) || CONTENT_WRITERS.test(name);

// What a shell line would do that the agent may not: "human" (a human-only command), "rails",
// "clean" (git clean -x), "state" (change .flow/), "complex" (past what the reader follows), or
// null. ctx = { root, cwd, skillDir } adds the rails check; without it only the state is checked.
export function shellViolation(command, ps, ctx) {
  const { cmds, failed, complex, code } = shellCommands(command, { ps });
  if (complex) return "complex";
  // After `cd x` (or Set-Location, pushd) paths resolve from x, so each command is checked from
  // every folder the line moves to, as well as from where it starts.
  const ctxs = [ctx];
  for (const w of ctx ? cmds : []) {
    const { name, args } = head(w);
    if (!CHDIR.test(name)) continue;
    const to = args.filter((x) => !/^[-+]/.test(x.text)).pop()?.text ?? "~";
    ctxs.push({ ...ctx, cwd: path.resolve(ctxs[ctxs.length - 1].cwd, to.replace(/^~(?=\/|\\|$)/, os.homedir())) });
  }
  const found = new Set(cmds.flatMap((w) => ctxs.flatMap((c) => [commandViolation(w, c), c && railsViolation(w, c)])).filter(Boolean));
  // PowerShell that calls .NET (`[IO.File]::WriteAllText(...)`, `(Get-Item x).Delete()`) can open
  // any path, like interpreter code, so any mention of the state or the rails counts.
  for (const t of code) if (/\.flow/i.test(t) || (ctx && codeTouchesRails(t, ctx))) found.add(/\.flow/i.test(t) ? "state" : "rails");
  const pipeWriter = (w) => {
    const { k, name, args } = head(w);
    if (!pipeWrites(name)) return false;
    if (CONTENT_WRITERS.test(name) && contentTargets(args).length) return false;
    if (!/^(xargs|parallel)$/.test(name)) return true;
    // xargs runs a program on what it reads: only readers (and echo) leave .flow/ alone.
    let j = k + 1;
    while (j < w.length && /^-/.test(w[j].text)) j += /^-[IndPLsEa]$/.test(w[j].text) ? 2 : 1;
    const prog = j < w.length ? programName(w[j].text) : "echo";
    return !pureReader(prog) && !["echo", "printf"].includes(prog);
  };
  const statePiped = cmds.some((w) => w.piped && pipeWriter(w)) && cmds.some((w) => w.some((x) => isStateWord(x.text, w.ps, ctx)));
  if (statePiped) found.add("state");
  if (failed) {
    // Unreadable as shell: fall back to the raw text, conservatively.
    if (/(?:(?<![\w-])|scripts)flow\.mjs["']?\s+(?!\s|request\s|answer\s)(.*\s)?(approve|reject|suspend|hook|mcp)\b/i.test(command)) found.add("human");
    if (/(^|[\s'"=:(/\\,])\.flow([\\/\s'")]|$)/i.test(command)) found.add("state");
  }
  if (failed && ctx && (/disableAllHooks/i.test(command) || norm(command).includes(norm(path.relative(ctx.root, ctx.skillDir))))) found.add("rails");
  return ["human", "agent", "rails", "clean", "state"].find((v) => found.has(v)) || null;
}
