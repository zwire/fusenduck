// Bindings: what makes a skill reusable across repositories.
// A skill names project-specific values (commands, paths, globs, URLs, branch names) only through
// bindings: `${name}`, declared with a description in the skill's bindings.md and given a value per
// project in <root>/.flow/<skill>/project.md. The skill itself stays the same in every repository.

import fs from "node:fs";
import path from "node:path";
import { parseFrontmatter } from "./frontmatter.mjs";

export const BINDING_RE = /\$\{([a-z][a-z0-9_-]*)\}/g;
export const PROJECT_FILE = "project.md";
export const bindingNames = (text) => new Set([...String(text).matchAll(BINDING_RE)].map((m) => m[1]));
export const projectFile = (root, skillName) => path.join(root, ".flow", skillName, PROJECT_FILE);

// A binding's value as a list of strings; an empty string or list means unbound.
const valueList = (v) => (v === undefined || v === null ? [] : (Array.isArray(v) ? v : [v]).map(String).filter((x) => x.trim() !== ""));

// The project's values: { values: Map(name -> string[]), problems }. Missing file -> empty map.
export function readProject(file) {
  if (!fs.existsSync(file)) return { values: new Map(), problems: [], exists: false };
  const { data, problems } = parseFrontmatter(fs.readFileSync(file, "utf8"));
  const values = new Map();
  for (const [k, v] of Object.entries(data || {})) if (valueList(v).length) values.set(k, valueList(v));
  return { values, problems: data ? problems : [...problems, "missing YAML frontmatter"], exists: true };
}

const reEscape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// Resolve one string. Prose joins list values with ", "; inside a /regex/ pattern each value is
// escaped and a list becomes an alternation. Unbound names are left as they are and reported.
export function resolveText(text, values, missing = new Set()) {
  const re = String(text).match(/^\/(.+)\/([a-z]*)$/);
  const sub = (s, regex) => s.replace(BINDING_RE, (m, name) => {
    const v = values.get(name);
    if (!v) { missing.add(name); return m; }
    return regex ? (v.length > 1 ? `(?:${v.map(reEscape).join("|")})` : reEscape(v[0])) : v.join(", ");
  });
  return re ? `/${sub(re[1], true)}/${re[2]}` : sub(String(text), false);
}

// Resolve a rails list (checks, writes, irreversible). An entry that mentions a list binding
// becomes one entry per value, so `${code}/**` with code [src, test] gives src/** and test/**.
export function resolveList(list, values, missing = new Set()) {
  const out = [];
  for (const entry of list) {
    if (/^\/.+\/[a-z]*$/.test(entry)) { out.push(resolveText(entry, values, missing)); continue; }
    let parts = [entry];
    for (const name of bindingNames(entry)) {
      const v = values.get(name);
      if (!v) { missing.add(name); continue; }
      parts = parts.flatMap((p) => v.map((x) => p.split(`\${${name}}`).join(x)));
    }
    out.push(...parts);
  }
  return out;
}

// Text that only fits one repository: paths (./x, ../x, ~/x, /x, dir/, a/b.ext, globs) and URLs.
// Paths that exist inside the skill itself (scripts/flow.mjs, playbooks/x.md) and the runtime's
// .flow/ directory are fine; so are bindings and <placeholders>.
export function repoSpecific(text, skillDir, baseDir = skillDir) {
  const hits = new Set();
  for (const raw of String(text).split(/[\s`"'()[\],;|]+/)) {
    const t = raw.replace(/^\*\*(?=\S)/, "").replace(/[.:!?]+$/, "");
    if (!/\w/.test(t) || /[<>]|\$\{|\{\{|\}\}/.test(t)) continue;
    if (/^https?:\/\//i.test(t)) { hits.add(t); continue; }
    if (!t.includes("/") || /^[a-z][a-z0-9+.-]*:/i.test(t)) continue;
    const pathish = /^(\.{1,2}|~)?\/[\w.@*-]/.test(t) || /\/\**$/.test(t) || t.includes("*") || /\/[\w@-][\w@.-]*\.[a-z][a-z0-9]{0,5}$/i.test(t);
    if (!pathish) continue;
    const rel = t.split("#")[0];
    if (/^\.flow(\/|$)/.test(rel)) continue;
    const inSkill = (d) => d && !path.isAbsolute(rel) && !rel.startsWith("~") && fs.existsSync(path.join(d, rel.replace(/\/\*+$/, "")));
    if (inSkill(skillDir) || inSkill(baseDir)) continue;
    hits.add(t);
  }
  return [...hits];
}

// bindings.md: `name: what the project must supply` in the frontmatter, one line per binding.
export function readBindings(dir, err, warn) {
  const out = new Map();
  const file = path.join(dir, "bindings.md");
  if (!fs.existsSync(file)) return out;
  const { data, problems } = parseFrontmatter(fs.readFileSync(file, "utf8"));
  for (const pr of problems) err("bindings.md", pr);
  if (!data) { err("bindings.md", "missing YAML frontmatter (`name: what the project supplies`, one per binding)"); return out; }
  for (const [k, v] of Object.entries(data)) {
    if (!/^[a-z][a-z0-9_-]*$/.test(k)) err("bindings.md", `binding name "${k}" must be lowercase letters, digits, - and _, starting with a letter`);
    if (typeof v !== "string" || v.trim() === "") err("bindings.md", `\`${k}\` needs a one-line description of what the project supplies`);
    out.set(k, typeof v === "string" ? v : "");
  }
  return out;
}
