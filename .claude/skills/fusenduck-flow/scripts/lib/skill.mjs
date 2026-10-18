// Validating a whole skill: the router, the playbooks as a graph, the profile, the runtime copy and
// the bindings.

import fs from "node:fs";
import path from "node:path";
import { VERSION, RUNTIME, SKILL_FIELDS, NAME_RE, LIFECYCLE_RANK, RANK_NAME } from "./contract.mjs";
import { parseFrontmatter } from "./frontmatter.mjs";
import { bindingNames, projectFile, readProject, repoSpecific, readBindings } from "./bindings.mjs";
import { validatePlaybook } from "./playbook.mjs";
import { readProfile, checkComposition } from "./profile.mjs";

export function validateSkill(dir, { project } = {}) {
  const errors = [];
  const warnings = [];
  const err = (where, msg) => errors.push(`${where}: ${msg}`);
  const warn = (where, msg) => warnings.push(`${where}: ${msg}`);
  const empty = { ok: false, errors, warnings, nodes: [], edges: [], entries: [], profile: null, bindings: {}, project: null };

  const skillPath = path.join(dir, "SKILL.md");
  if (!fs.existsSync(skillPath)) { err("SKILL.md", "missing"); return empty; }
  const skillText = fs.readFileSync(skillPath, "utf8");
  const { data: fm, body: skillBody, problems } = parseFrontmatter(skillText);
  for (const p of problems) err("SKILL.md", p);
  const dirName = path.basename(path.resolve(dir));
  // The router is a plain Agent Skills skill, so any agent that implements the spec can load it.
  if (!fm) err("SKILL.md", "missing YAML frontmatter");
  else {
    for (const k of Object.keys(fm)) {
      if (!SKILL_FIELDS.includes(k)) err("SKILL.md", `frontmatter field \`${k}\` is not in the Agent Skills specification (${SKILL_FIELDS.join(", ")}); keep harness-specific settings out of the skill`);
    }
    if (!fm.name) err("SKILL.md", "frontmatter `name` is required");
    else {
      if (!NAME_RE.test(fm.name) || fm.name.length > 64) err("SKILL.md", `name "${fm.name}" must be 1-64 lowercase letters, digits and single hyphens`);
      if (fm.name !== dirName) err("SKILL.md", `name "${fm.name}" must match the directory name "${dirName}"`);
    }
    if (!fm.description) err("SKILL.md", "frontmatter `description` is required");
    else if (String(fm.description).length > 1024) err("SKILL.md", "description exceeds 1024 characters");
    if (fm.compatibility !== undefined && (typeof fm.compatibility !== "string" || fm.compatibility.length < 1 || fm.compatibility.length > 500)) err("SKILL.md", "`compatibility` must be 1-500 characters");
    if (fm.metadata !== undefined && (typeof fm.metadata !== "object" || Array.isArray(fm.metadata) || Object.values(fm.metadata).some((v) => typeof v !== "string"))) {
      err("SKILL.md", "`metadata` must map string keys to string values (quote numbers)");
    }
    if (fm["allowed-tools"] !== undefined && typeof fm["allowed-tools"] !== "string") err("SKILL.md", "`allowed-tools` must be a space-separated string");
  }
  const skillLines = skillText.split(/\r?\n/).length;
  if (skillLines > 500) warn("SKILL.md", `${skillLines} lines; keep the router under 500 lines and move detail into playbooks`);

  const profile = readProfile(dir, err, warn);

  // playbooks
  const pbDir = path.join(dir, "playbooks");
  const files = fs.existsSync(pbDir) ? fs.readdirSync(pbDir).filter((f) => f.endsWith(".md")).sort() : [];
  if (files.length === 0) err("playbooks/", "no playbooks found");
  const nodes = new Map();
  for (const f of files) {
    const id = f.replace(/\.md$/, "");
    const r = validatePlaybook(fs.readFileSync(path.join(pbDir, f), "utf8"), id, undefined, dir);
    errors.push(...r.errors);
    warnings.push(...r.warnings);
    if (r.node) nodes.set(id, r.node);
  }

  // edges
  const edges = [];
  for (const node of nodes.values()) {
    for (const e of node.exits) {
      if (!e || !e.to) continue;
      if (e.to === "end") { edges.push({ from: node.id, to: "end", when: e.when }); continue; }
      if (!nodes.has(e.to)) { err(`playbooks/${node.id}.md`, `exit target "${e.to}" does not exist`); continue; }
      edges.push({ from: node.id, to: e.to, when: e.when });
    }
  }
  const out = new Map([...nodes.keys()].map((k) => [k, []]));
  for (const e of edges) if (e.to !== "end") out.get(e.from).push(e.to);

  // Lifecycle raises must pass through a gate that declares the raise (`promotes: from->to`).
  // Walk from every node that fixes a lifecycle level; `any` nodes and gates without `promotes`
  // are transparent, so detours through service playbooks are caught too.
  const walk = (src, level) => {
    const visited = new Set([src.id]);
    const queue = [...out.get(src.id)];
    while (queue.length) {
      const id = queue.shift();
      if (visited.has(id)) continue;
      visited.add(id);
      const t = nodes.get(id);
      if (t.promotes) {
        const from = LIFECYCLE_RANK[t.promotes[0]];
        if (level < from) err(`playbooks/${src.id}.md`, `path to gate "${id}" arrives with ${RANK_NAME[level]} work, but the gate promotes from ${t.promotes[0]}`);
        continue;
      }
      const tr = LIFECYCLE_RANK[t.lifecycle];
      if (tr !== undefined) {
        if (tr > level) err(`playbooks/${src.id}.md`, `path to "${id}" raises lifecycle ${RANK_NAME[level]} -> ${t.lifecycle} without passing a gate that promotes it`);
        continue;
      }
      queue.push(...out.get(id));
    }
  };
  for (const n of nodes.values()) {
    if (n.promotes) walk(n, LIFECYCLE_RANK[n.promotes[1]]);
    else if (LIFECYCLE_RANK[n.lifecycle] !== undefined) walk(n, LIFECYCLE_RANK[n.lifecycle]);
  }

  // router: entries are playbooks the router links to
  const linked = new Set();
  for (const m of skillBody.matchAll(/playbooks\/([a-z0-9-]+)\.md/g)) linked.add(m[1]);
  for (const id of linked) if (!nodes.has(id)) err("SKILL.md", `routes to missing playbook "playbooks/${id}.md"`);
  const entries = [...linked].filter((id) => nodes.has(id));
  if (entries.length === 0 && nodes.size) err("SKILL.md", "router links to no playbooks");

  // reachability from router entries
  const seen = new Set(entries);
  const stack = [...entries];
  while (stack.length) for (const n of out.get(stack.pop())) if (!seen.has(n)) { seen.add(n); stack.push(n); }
  for (const id of nodes.keys()) if (!seen.has(id)) err(`playbooks/${id}.md`, "unreachable from the router (no route and no incoming exit)");

  // every node can reach an end (terminal or exit to end)
  const canEnd = new Set([...nodes.values()].filter((n) => n.terminal || n.exits.some((e) => e && e.to === "end")).map((n) => n.id));
  let changed = true;
  while (changed) {
    changed = false;
    for (const [id, outs] of out) if (!canEnd.has(id) && outs.some((o) => canEnd.has(o))) { canEnd.add(id); changed = true; }
  }
  for (const id of nodes.keys()) if (!canEnd.has(id)) err(`playbooks/${id}.md`, "cannot reach an end (trap cycle)");

  if (nodes.size > 15) warn("playbooks/", `${nodes.size} playbooks; vajra aims for 5-12 — prune what the profile does not need`);
  const levels = new Set([...nodes.values()].map((n) => n.lifecycle).filter((l) => l in LIFECYCLE_RANK));
  if (levels.size > 1 && ![...nodes.values()].some((n) => n.promotes)) warn("playbooks/", "multiple lifecycles but no gate declares `promotes`");

  // Domain fit: work and gate playbooks must speak in this domain's concrete terms.
  const anchor = /`[^`]+`|\]\(|\d/;
  for (const n of nodes.values()) {
    if (n.kind === "service") continue;
    if (n.doneWhen && !anchor.test(n.doneWhen)) warn(`playbooks/${n.id}.md`, '"Done when" names no concrete evidence (a command, path, metric or link); name what proves it in this domain');
    if (n.steps.length && !n.steps.some((s) => anchor.test(s.text))) warn(`playbooks/${n.id}.md`, "no step names a concrete command, tool or artifact; write the steps in this domain's terms");
  }

  // Runtime: generated skills carry their own copy of the rails.
  const rtLib = path.join(dir, "scripts", "lib", "contract.mjs");
  const rtMissing = RUNTIME.filter((f) => !fs.existsSync(path.join(dir, "scripts", f)));
  // A copy from before the runtime was split into lib/ lacks the whole folder; name it once.
  const noLib = RUNTIME.filter((f) => f.startsWith("lib/")).every((f) => rtMissing.includes(f));
  const shown = noLib ? [...rtMissing.filter((f) => !f.startsWith("lib/")), "lib/"] : rtMissing;
  if (rtMissing.length) warn("scripts/", `runtime missing (${shown.join(", ")}): nothing enforces the graph; copy flow.mjs, validate.mjs and lib/ from vajra's scripts/`);
  else {
    const v = fs.readFileSync(rtLib, "utf8").match(/export const VERSION = "([^"]+)"/);
    if (!v || v[1] !== VERSION) warn("scripts/", `runtime is vajra ${v ? v[1] : "unknown"}, validator is ${VERSION}; run Evolve to update the runtime`);
    if (!/scripts\/flow\.mjs/.test(skillBody)) warn("SKILL.md", "router does not tell the agent to drive the run with scripts/flow.mjs");
  }

  if (profile) checkComposition(profile, fm, nodes, err, warn);

  // Portability: the skill names project-specific values only through bindings.
  const bindings = readBindings(dir, err, warn);
  const used = new Map();
  const use = (where, names) => { for (const n of names) if (!used.has(n)) used.set(n, where); };
  for (const n of nodes.values()) use(`playbooks/${n.id}.md`, n.bindings);
  const prose = [["SKILL.md", skillText]];
  for (const f of ["principles.md", "profile.md"]) if (fs.existsSync(path.join(dir, f))) prose.push([f, fs.readFileSync(path.join(dir, f), "utf8")]);
  for (const [where, text] of prose) {
    use(where, bindingNames(text));
    const hits = repoSpecific(text, dir);
    if (hits.length) warn(where, `${hits.map((h) => `\`${h}\``).join(", ")} ${hits.length > 1 ? "look" : "looks"} repository-specific; use a binding (\`\${name}\` declared in bindings.md) so the skill works in any repository`);
  }
  for (const [name, where] of used) if (!bindings.has(name)) err(where, `binding \`\${${name}}\` is not declared in bindings.md`);
  for (const name of bindings.keys()) if (!used.has(name)) warn("bindings.md", `\`${name}\` is declared but no file uses \`\${${name}}\``);

  // Optional: does a project bind every name?
  let projectResult = null;
  if (project) {
    // A project root, or the project file itself.
    const file = /\.md$/i.test(project) && fs.existsSync(project) && fs.statSync(project).isFile() ? project : projectFile(project, dirName);
    const where = path.relative(process.cwd(), file) || file;
    const p = readProject(file);
    for (const pr of p.problems) err(where, pr);
    if (!p.exists) err(where, `missing; bind ${[...bindings.keys()].join(", ") || "nothing"} there (\`flow install\` writes a skeleton)`);
    const missing = [...bindings.keys()].filter((n) => !p.values.has(n));
    if (p.exists && missing.length) err(where, `no value for ${missing.map((n) => `\`${n}\``).join(", ")}`);
    for (const k of p.values.keys()) if (!bindings.has(k)) warn(where, `\`${k}\` is not declared in the skill's bindings.md`);
    projectResult = { file, values: Object.fromEntries(p.values), missing };
  }

  const list = [...nodes.values()].map((n) => ({ ...n, promotes: n.promotes ? n.promotes.join("->") : null }));
  return { ok: errors.length === 0, errors, warnings, nodes: list, edges, entries, profile, bindings: Object.fromEntries(bindings), project: projectResult };
}
