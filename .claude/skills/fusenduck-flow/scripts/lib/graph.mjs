// The workflow graph as the runtime uses it: the validated skill with this project's bindings
// filled in.

import path from "node:path";
import { skillDir, skillName, relPath } from "./env.mjs";
import { validateSkill } from "./skill.mjs";
import { projectFile, readProject, resolveText, resolveList } from "./bindings.mjs";

// The graph with this project's bindings filled in. Unbound names stay as written (so a `writes`
// glob matches nothing) and are listed in `unbound`; runs cannot start until the project binds them.
export function loadGraph(root) {
  const r = validateSkill(skillDir);
  const file = projectFile(root, skillName);
  const { values, problems } = readProject(file);
  const missing = new Set();
  const nodes = r.nodes.map((n) => ({
    ...n,
    checks: resolveList(n.checks, values, missing),
    writes: n.writes && resolveList(n.writes, values, missing),
    guards: resolveList(n.guards, values, missing),
    steps: n.steps.map((s) => ({ ...s, text: resolveText(s.text, values, missing) })),
    doneWhen: resolveText(n.doneWhen, values, missing),
    used: n.bindings.map((b) => [b, values.get(b)]),
  }));
  // Guarded commands whose binding has no value cannot be recognized; the session is told so.
  const guardGap = new Set();
  for (const n of r.nodes) resolveList(n.guards, values, guardGap);
  for (const name of Object.keys(r.bindings || {})) if (!values.has(name)) missing.add(name);
  const errors = [...r.errors, ...problems.map((p) => `${path.relative(root, file)}: ${p}`)];
  return {
    ok: errors.length === 0, errors, nodes: new Map(nodes.map((n) => [n.id, n])), entries: r.entries, profile: r.profile || {},
    bindings: r.bindings || {}, unbound: [...missing].sort(), unboundGuards: [...guardGap].sort(), projectFile: relPath(root, file),
  };
}
