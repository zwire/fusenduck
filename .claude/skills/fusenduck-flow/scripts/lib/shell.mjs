// Reading shell lines for the hooks: what a line would run, in POSIX shell and PowerShell, and
// whether a guarded command is among it. Part of the security boundary of the rails (with
// tools.mjs and protect.mjs): every reading fails closed when unsure.
//
// A small reader for POSIX shells and PowerShell: splits a command line into the simple commands
// it would run, with their words unquoted. Text that is only data (quoted arguments, comments,
// heredoc bodies) stays inside one word or is dropped, while code the shell would run from inside
// it is read as commands of its own: $(...), `...` and <(...); the script of `sh -c`, `eval`,
// `ssh`, `watch`, `pwsh -Command`, `pwsh -EncodedCommand`, `cmd /c`, `Invoke-Expression` and
// `Start-Process`; and heredocs or pipes that feed a shell its script on stdin.
// Each command is an array of { text, quoted, redir } words (redir: the operator before a redirected
// path); `ps` on the array marks PowerShell, `piped` and `fed` that its stdin comes from a pipe or a heredoc.

import { commandMatches } from "./match.mjs";

const SHELLS = new Set(["sh", "bash", "zsh", "dash", "ksh", "fish", "su"]);
const POWERSHELLS = new Set(["pwsh", "powershell"]);
const START_PARAM = /^-(file(path)?|argumentlist|args?|wait|nonewwindow|passthru|workingdirectory|windowstyle|verb|credential|redirectstandard\w*|loaduserprofile|usenewenvironment|environment|scriptblock|computername|session|asjob)$/i;
const WRAPPERS = new Set(["sudo", "env", "exec", "nohup", "command", "time", "nice", "doas", "&", "."]);
const KEYWORDS = new Set(["if", "then", "else", "elif", "do", "while", "until", "!", "{", "}", "time"]);
// Past these limits a line is not read further but refused as too complex: scripts nested deeper
// than MAX_DEPTH would otherwise go unchecked, and a line built to multiply the work (`ssh ssh ...`)
// would run the hook into its timeout, which most agents treat as "allow".
const MAX_DEPTH = 8;
const MAX_READS = 500;
const MAX_CHARS = 4_000_000;
class TooComplex extends Error {}

// The program a word names, as the shell would look it up: no directory, no Windows extension (.exe, .cmd, .bat, .ps1), any case.
export const programName = (t) => t.replace(/\\/g, "/").split("/").pop().toLowerCase().replace(/\.(exe|cmd|bat|ps1)$/, "");

// Index of the first word that is the program itself, past assignments and wrappers like sudo.
export function commandStart(w) {
  let k = 0;
  while (k < w.length - 1 && (/^\w+=/.test(w[k].text) || (k > 0 && /^-/.test(w[k].text)) || WRAPPERS.has(programName(w[k].text)))) k++;
  return k;
}

function closing(s, i, open, close, esc) {
  // i is just past `open`; returns the index of the matching `close`, skipping quotes and escapes.
  for (let depth = 1; i < s.length; i++) {
    const c = s[i];
    if (c === esc) i++;
    else if (c === "'") { i = s.indexOf("'", i + 1); if (i < 0) break; }
    else if (c === '"') { for (i++; i < s.length && s[i] !== '"'; i++) if (s[i] === esc) i++; }
    else if (c === open) depth++;
    else if (c === close && --depth === 0) return i;
  }
  throw new Error("unclosed " + open);
}

// Commands substituted inside double quotes, here-strings or an unquoted heredoc body.
function substitutions(s, nested, ps) {
  const esc = ps ? "`" : "\\";
  for (let i = 0; i < s.length; i++) {
    if (s[i] === esc) i++;
    else if (s[i] === "$" && s[i + 1] === "(") { const e = closing(s, i + 2, "(", ")", esc); nested.push({ text: s.slice(i + 2, e), ps }); i = e; }
    else if (!ps && s[i] === "`") { const e = s.indexOf("`", i + 1); if (e < 0) throw new Error("unclosed `"); nested.push({ text: s.slice(i + 1, e), ps }); i = e; }
  }
}

function decodeEncodedCommand(b64) {
  try { return Buffer.from(b64, "base64").toString("utf16le"); } catch { return ""; }
}

function tokenize(s, ps, nested, bodies) {
  const cmds = [], heredocs = [];
  let words = [], word = null, redir = false, piped = false, fed = false;
  const flush = () => { if (word) { words.push(word); word = null; } };
  // `piped`: stdin comes from the command before; `fed`: from a heredoc.
  const end = (pipe = false) => { flush(); if (words.length) { words.piped = piped; words.fed = fed; cmds.push(words); } words = []; redir = false; piped = pipe; fed = false; };
  const add = (t, quoted) => { word ||= { text: "", quoted: false, redir }; word.text += t; word.quoted ||= quoted; redir = false; };
  const esc = ps ? "`" : "\\";
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === "\r") continue;
    if (c === "\n") {
      end();
      for (const h of heredocs) {
        const lines = [];
        let j = i + 1;
        for (;;) {
          const nl = s.indexOf("\n", j), line = s.slice(j, nl < 0 ? s.length : nl).replace(/\r$/, "");
          j = nl < 0 ? s.length : nl + 1;
          if ((h.tabs ? line.replace(/^\t+/, "") : line) === h.delim) break;
          lines.push(line);
          if (nl < 0) break;
        }
        bodies.push(lines.join("\n"));
        if (!h.quoted) substitutions(bodies[bodies.length - 1], nested, false);
        i = j - 1;
      }
      heredocs.length = 0;
    } else if (c === " " || c === "\t") flush();
    else if (ps && c === "<" && s[i + 1] === "#") { const e = s.indexOf("#>", i + 2); if (e < 0) throw new Error("unclosed <#"); i = e + 1; }
    else if (c === "#" && !word) { const nl = s.indexOf("\n", i); i = (nl < 0 ? s.length : nl) - 1; }
    else if (c === esc) { if (s[i + 1] !== "\n") add(s[i + 1] ?? "", false); i++; }
    else if (ps && c === "@" && (s[i + 1] === '"' || s[i + 1] === "'") && /^\r?\n/.test(s.slice(i + 2))) {
      // PowerShell here-string: data up to a line that starts with "@ or '@.
      const q = s[i + 1], e = s.indexOf(`\n${q}@`, i + 2);
      if (e < 0) throw new Error("unclosed here-string");
      const t = s.slice(s.indexOf("\n", i) + 1, e).replace(/\r$/, "");
      if (q === '"') substitutions(t, nested, true);
      add(t, true); i = e + 2;
    } else if (c === "'") {
      let t = "", j = i + 1;
      for (;; j++) {
        const e = s.indexOf("'", j);
        if (e < 0) throw new Error("unclosed '");
        t += s.slice(j, e);
        if (ps && s[e + 1] === "'") { t += "'"; j = e + 1; continue; }
        j = e; break;
      }
      add(t, true); i = j;
    } else if (c === '"') {
      let t = "", raw = "", j = i + 1;
      for (; j < s.length; j++) {
        if (s[j] === '"') { if (ps && s[j + 1] === '"') { t += '"'; raw += '""'; j++; continue; } break; }
        if (s[j] === esc && (ps || '"\\$`\n'.includes(s[j + 1]))) { t += s[j + 1]; raw += s[j] + s[j + 1]; j++; }
        else if (s[j] === "$" && s[j + 1] === "(") { const e = closing(s, j + 2, "(", ")", esc); t += s.slice(j, e + 1); raw += s.slice(j, e + 1); j = e; }
        else if (!ps && s[j] === "`") { const e = s.indexOf("`", j + 1); if (e < 0) throw new Error("unclosed `"); t += s.slice(j, e + 1); raw += s.slice(j, e + 1); j = e; }
        else { t += s[j]; raw += s[j]; }
      }
      if (j >= s.length) throw new Error('unclosed "');
      substitutions(raw, nested, ps);
      add(t, true); i = j;
    } else if ((c === "$" || (ps && c === "@")) && s[i + 1] === "(") {
      const e = closing(s, i + 2, "(", ")", esc); nested.push({ text: s.slice(i + 2, e), ps }); add(s.slice(i, e + 1), false); i = e;
    } else if (!ps && c === "`") { const e = s.indexOf("`", i + 1); if (e < 0) throw new Error("unclosed `"); nested.push({ text: s.slice(i + 1, e), ps }); add(s.slice(i, e + 1), false); i = e; }
    else if (!ps && (c === "<" || c === ">") && s[i + 1] === "(") { const e = closing(s, i + 2, "(", ")", esc); nested.push({ text: s.slice(i + 2, e), ps }); flush(); i = e; }
    else if (c === "<" || c === ">") {
      if (word && !word.quoted && (/^\d+$/.test(word.text) || (ps && word.text === "*"))) word = null; // 2>&1, *>: the stream is not a word
      flush();
      const op = s.slice(i).match(/^(<<-|<<<|<<|<>|>>|>\||[<>]&?|&?>>?)/)[0];
      i += op.length - 1;
      if (!ps && (op === "<<" || op === "<<-")) {
        const m = s.slice(i + 1).match(/^[ \t]*(?:'([^']*)'|"([^"]*)"|\\?([^\s;&|<>()]+))/);
        if (!m) throw new Error("heredoc without delimiter");
        heredocs.push({ delim: m[1] ?? m[2] ?? m[3], quoted: m[1] !== undefined || m[2] !== undefined || m[0].includes("\\"), tabs: op === "<<-" });
        fed = true;
        i += m[0].length;
      } else redir = op; // the operator: `<` reads, `>` writes
    } else if (!ps && c === "&" && s[i + 1] === ">") { flush(); i += s[i + 2] === ">" ? 2 : 1; redir = ">"; }
    else if (c === "|" && s[i + 1] === "|") { end(); i++; }
    else if (c === "|") { end(true); if (s[i + 1] === "&") i++; }
    else if (";&|()".includes(c) || (ps && "{}".includes(c))) end();
    else add(c, false);
  }
  end();
  return cmds;
}

function readShell(s, depth, ps, ctx) {
  if (++ctx.reads > MAX_READS) throw new TooComplex("too many nested scripts");
  if (ps && /\]\s*::|\)\s*\.\s*\w+\s*\(/.test(s)) ctx.code.push(s); // .NET calls: read as code by the callers
  const nested = [], bodies = [];
  const out = [];
  for (let w of tokenize(s, ps, nested, bodies)) {
    // Taken before keywords are dropped: slicing them off makes a new array without these marks.
    const { piped, fed } = w;
    while (w.length && !w[0].quoted && (ps ? ["&", "."].includes(w[0].text) : KEYWORDS.has(w[0].text))) w = w.slice(1);
    if (!w.length) continue;
    w.ps = ps;
    w.piped = piped;
    w.fed = fed;
    out.push(w);
    const rest = (k) => w.slice(k).map((x) => x.text).join(" ");
    for (let k = 0; k < w.length; k++) {
      const name = programName(w[k].text);
      if (SHELLS.has(name)) {
        const c = w.findIndex((x, j) => j > k && /^-[a-z]*c[a-z]*$/i.test(x.text));
        if (c > 0 && w[c + 1]) nested.push({ text: w[c + 1].text, ps: false });
      } else if (POWERSHELLS.has(name)) {
        // Every argument may start the script (-Command, or positional for powershell.exe, after any
        // of its own parameters); an encoded one is decoded.
        for (let j = k + 1; j < w.length; j++) nested.push({ text: rest(j), ps: true });
        for (let j = k + 1; j < w.length - 1; j++) {
          if (/^[-/](e|ec|en[a-z]*)$/i.test(w[j].text)) nested.push({ text: decodeEncodedCommand(w[j + 1].text), ps: true });
        }
      } else if (name === "cmd" && w.slice(k + 1).some((x) => /^\/[ck]$/i.test(x.text))) {
        nested.push({ text: rest(w.findIndex((x, j) => j > k && /^\/[ck]$/i.test(x.text)) + 1), ps: true });
      }
    }
    const head = programName(w[commandStart(w)].text);
    if (head === "eval" || head === "watch") nested.push({ text: rest(commandStart(w) + 1), ps });
    if (["invoke-expression", "iex", "start-process", "saps", "start", "invoke-command", "icm"].includes(head)) {
      nested.push({ text: rest(commandStart(w) + 1), ps: true });
      // Start-Process npm -ArgumentList 'run deploy' runs `npm run deploy`; only its own parameters
      // are dropped, so `-ArgumentList '-p','x'` keeps the program's `-p`.
      nested.push({ text: w.slice(commandStart(w) + 1).filter((x) => !START_PARAM.test(x.text)).map((x) => x.text.replace(/,/g, " ")).join(" "), ps: true });
    }
    if (head === "ssh") for (let k = 1; k < w.length; k++) nested.push({ text: rest(k), ps });
  }
  // A shell reading its script from stdin (`bash <<EOF`, `cat x | sh`, `bash <<< "..."`,
  // `"..." | pwsh -Command -`) runs whatever the line feeds it: heredoc bodies and the other
  // commands' arguments become code.
  for (const w of out) {
    const k = commandStart(w), name = programName(w[k].text), args = w.slice(k + 1);
    const flagsOnly = args.every((x) => x.redir || x.text === "-" || /^-(?!c$|[a-z]*c$)/i.test(x.text) || (POWERSHELLS.has(name) && /^-(c|com\w*)$/i.test(x.text)));
    const stdinShell = SHELLS.has(name) ? flagsOnly && !args.some((x) => /^-[a-z]*c[a-z]*$/i.test(x.text))
      : POWERSHELLS.has(name) ? flagsOnly || args.some((x) => x.text === "-")
      : name === "cmd" ? !args.some((x) => /^\/[ck]$/i.test(x.text)) : false;
    if (!stdinShell) continue;
    const dialect = !SHELLS.has(name);
    for (const b of bodies) nested.push({ text: b, ps: dialect });
    for (const v of out) if (v !== w) nested.push({ text: v.slice(v[0].quoted ? 0 : 1).map((x) => x.text).join(" "), ps: dialect });
    for (const x of args) if (x.redir) nested.push({ text: x.text, ps: dialect });
  }
  ctx.chars += nested.reduce((sum, n) => sum + n.text.length, 0);
  if (ctx.chars > MAX_CHARS) throw new TooComplex("too much nested script text");
  // Each script is read once, so repeats (every suffix of `ssh a b c`) cost nothing deeper down.
  const fresh = nested.filter((n) => n.text.trim() && !ctx.seen.has(`${n.ps}:${n.text}`));
  for (const n of fresh) ctx.seen.add(`${n.ps}:${n.text}`);
  if (fresh.length && depth >= MAX_DEPTH) throw new TooComplex("scripts nested too deeply");
  for (const n of fresh) out.push(...readShell(n.text, depth + 1, n.ps, ctx));
  return out;
}

// Reads a command line in the shell it runs in: POSIX (ps false), PowerShell (ps true), or both
// (ps "both") when the shell is not known, so a check sees every way the line could run. `failed` is set when a reading failed (an unclosed quote, say);
// callers then also check the raw text, so they fail closed. `complex` is set when the line is past
// the reader's limits; callers refuse it outright. `code` lists the PowerShell scripts that call
// .NET, which can open any path, so callers read them as code.
export function shellCommands(command, { ps = false } = {}) {
  const cmds = [], code = [];
  let failed = false, complex = false;
  for (const dialect of ps === "both" ? [false, true] : [!!ps]) {
    try { cmds.push(...readShell(String(command), 0, dialect, { seen: new Set(), reads: 0, chars: 0, code })); } catch (e) { failed = true; if (e instanceof TooComplex) complex = true; }
  }
  return { cmds, failed, complex, code };
}

// Programs that read, edit, list or move the files they are given and never run them, so a guarded
// script named as their argument (`cat scripts/release.sh`, `git diff scripts/release.sh`) is not run.
const FILE_TOOLS = new Set(["cat", "head", "tail", "less", "more", "ls", "wc", "grep", "egrep", "fgrep", "rg", "jq", "stat", "file", "diff", "cmp",
  "tree", "du", "sort", "uniq", "cut", "od", "xxd", "hexdump", "strings", "md5sum", "sha1sum", "sha256sum", "shasum", "sed", "awk",
  "vi", "vim", "nvim", "nano", "emacs", "code", "subl", "cp", "mv", "ln", "chmod", "chown", "touch", "mkdir", "rm", "shellcheck", "shfmt",
  "get-content", "gc", "type", "get-childitem", "gci", "dir", "select-string", "sls", "findstr", "test-path", "get-item", "gi", "get-filehash",
  "copy-item", "cpi", "move-item", "mi", "remove-item", "ri", "del", "notepad"]);
const GIT_FILE_COMMANDS = new Set(["add", "rm", "mv", "diff", "log", "show", "blame", "status", "checkout", "restore", "ls-files", "grep", "commit", "reset", "stash"]);
const DATA = new Set(["echo", "printf", "write-output", "write-host"]);

// A command guard matches where a command, or a path to the program it runs, starts: at its first
// word, at an unquoted later word (`sudo npm run deploy`, `bash scripts/release.sh`), or after a `/`
// in one (`./scripts/release.sh`). A match that starts inside a quoted argument (a commit message,
// a grep pattern) is data, not a command, and so is an argument of a program that only handles
// files (FILE_TOOLS). PowerShell is matched without regard to case, as it runs commands. A line the
// reader cannot parse is also matched as plain text.
export function guardMatches(pattern, command, { ps = false } = {}) {
  const { cmds, failed, complex } = shellCommands(command, { ps });
  if (complex || (failed && commandMatches(pattern, command))) return true;
  const re = pattern.match(/^\/(.+)\/([a-z]*)$/);
  for (const w of cmds) {
    const st = commandStart(w), prog = programName(w[st].text);
    if (DATA.has(prog)) continue;
    const sub = w.slice(st + 1).find((x) => !/^-/.test(x.text))?.text;
    const last = FILE_TOOLS.has(prog) || (prog === "git" && GIT_FILE_COMMANDS.has(sub)) ? st : w.length - 1;
    const sticky = re && new RegExp(re[1], re[2].replace(/[gy]/g, "") + (w.ps && !re[2].includes("i") ? "iy" : "y"));
    const lit = pattern.replace(/\s+/g, " ").trim();
    const norm = (t) => (w.ps ? t.toLowerCase() : t);
    const text = w.map((x) => x.text.replace(/\\/g, w.ps ? "/" : "\\")).join(" ");
    let at = 0;
    for (const [k, x] of w.entries()) {
      if (k > last) break;
      if (!x.redir && (k === 0 || (!x.quoted && !/\s/.test(x.text)))) {
        for (let j = 0; j < x.text.length; j++) {
          if (j > 0 && !"/\\".includes(x.text[j - 1])) continue;
          const rest = text.slice(at + j);
          if (sticky ? (sticky.lastIndex = 0, sticky.test(rest)) : norm(rest).startsWith(norm(lit))) return true;
        }
      }
      at += x.text.length + 1;
    }
  }
  return false;
}
