// Matching commands and paths: guarded command patterns, the commands a step names, and `writes`
// globs. Shared by the validator, the runtime and the hook checks.

// Command patterns: "/regex/flags" is a regular expression, anything else matches as a substring
// of the whitespace-normalized command.
export function commandMatches(pattern, command) {
  const cmd = String(command).replace(/\s+/g, " ").trim();
  const re = pattern.match(/^\/(.+)\/([a-z]*)$/);
  return re ? new RegExp(re[1], re[2]).test(cmd) : cmd.includes(pattern.replace(/\s+/g, " ").trim());
}

// A step's own commands for a guarded pattern: the backtick spans of its text that the pattern
// matches. A step that names the command only in prose has none.
export function stepCommands(step, pattern) {
  return [...step.text.matchAll(/`([^`]+)`/g)].map((m) => m[1].trim()).filter((x) => { try { return commandMatches(pattern, x); } catch { return false; } });
}

// Whether a command line could be this step's: every word of one of its commands appears in the
// line in order, with `<...>` standing for any value. Other words (flags, quotes) may come between.
// A step without its own command fits any line.
export function fitsStep(step, pattern, line) {
  const own = stepCommands(step, pattern);
  if (!own.length) return true;
  const words = String(line).trim().split(/\s+/).map((w) => w.replace(/^["']+|["']+$/g, ""));
  return own.some((x) => {
    const tpl = x.split(/\s+/).map((t) => new RegExp(`^${t.split(/<[^<>]*>/).map((q) => q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("\\S+")}$`));
    let i = 0;
    for (const w of words) if (i < tpl.length && tpl[i].test(w)) i++;
    return i === tpl.length;
  });
}

// Human gates before step n: steps with the same count wait for the same gates.
export const gatesBefore = (steps, n) => steps.filter((s) => s.n < n && s.humanGate).length;

// Path globs relative to the project root: ** spans directories, * and ? stay within one.
export function globToRegExp(glob) {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*" && glob[i + 1] === "*") {
      if (glob[i + 2] === "/") { re += "(?:.*/)?"; i += 2; } else { re += ".*"; i += 1; }
    } else if (c === "*") re += "[^/]*";
    else if (c === "?") re += "[^/]";
    else re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${re}$`);
}
