// Validating one playbook file on its own (no graph context). Used by validateSkill and by the
// blueprint tests.

import path from "node:path";
import { PLAYBOOK_KEYS, REQUIRED_SECTIONS, PHASES, LIFECYCLES, KINDS, PROMOTES_RE, LIFECYCLE_RANK } from "./contract.mjs";
import { parseFrontmatter, sections } from "./frontmatter.mjs";
import { commandMatches, stepCommands, fitsStep, gatesBefore } from "./match.mjs";
import { bindingNames, resolveText, repoSpecific } from "./bindings.mjs";

export function validatePlaybook(text, id, where = `playbooks/${id}.md`, skillDir = null) {
  const errors = [];
  const warnings = [];
  const err = (msg) => errors.push(`${where}: ${msg}`);
  const warn = (msg) => warnings.push(`${where}: ${msg}`);

  const { data, body, problems } = parseFrontmatter(text);
  for (const p of problems) err(p);
  if (!data) { err("missing YAML frontmatter"); return { node: null, errors, warnings }; }
  for (const k of Object.keys(data)) if (!PLAYBOOK_KEYS.includes(k)) warn(`unknown frontmatter key "${k}"`);
  if (data.id !== id) err(`frontmatter id "${data.id}" must equal file name "${id}"`);

  const secs = sections(body);
  // Only numbered steps are steps: the runtime records and gates them, so a tag on a bullet would
  // satisfy the validator while nothing stops at it.
  const steps = (secs.get("Steps") || []).filter((l) => /^\d+\.\s/.test(l)).map((l, i) => ({
    n: i + 1,
    text: l.replace(/^\d+\.\s+/, "").trim(),
    humanGate: /\[human-gate\]/i.test(l),
    irreversible: /\[irreversible\]/i.test(l),
  }));
  const node = {
    id,
    title: data.title || id,
    phase: data.phase,
    lifecycle: data.lifecycle,
    kind: data.kind || "work",
    promotes: null,
    terminal: data.terminal === true,
    exits: Array.isArray(data.exits) ? data.exits : [],
    humanGates: steps.filter((s) => s.humanGate).length,
    irreversibleSteps: steps.filter((s) => s.irreversible).length,
    steps,
    doneWhen: (secs.get("Done when") || []).join("\n").trim(),
    checks: [],
    writes: null,
    guards: [],
  };

  if (!PHASES.includes(node.phase)) err(`phase must be one of ${PHASES.join("|")}`);
  if (!LIFECYCLES.includes(node.lifecycle)) err(`lifecycle must be one of ${LIFECYCLES.join("|")}`);
  if (!KINDS.includes(node.kind)) err(`kind must be one of ${KINDS.join("|")}`);
  if ((node.phase === "explore" && node.lifecycle === "hardened") || (node.phase === "extract" && node.lifecycle === "throwaway")) {
    warn(`phase ${node.phase} with lifecycle ${node.lifecycle} is unusual; check both`);
  }

  if (data.promotes !== undefined) {
    const pm = String(data.promotes).match(PROMOTES_RE);
    if (node.kind !== "gate") err("only gate playbooks (kind: gate) may declare `promotes`");
    else if (!pm) err('promotes must look like "throwaway->tracer"');
    else if (LIFECYCLE_RANK[pm[2]] <= LIFECYCLE_RANK[pm[1]]) err(`promotes ${pm[1]}->${pm[2]} does not raise the lifecycle`);
    else node.promotes = [pm[1], pm[2]];
  }
  if (node.kind === "gate" && !node.promotes && data.promotes === undefined && node.humanGates === 0) {
    warn("gate neither promotes a lifecycle nor stops at a [human-gate]; make it a work playbook or give it a job");
  }

  // rails: machine checks for "Done when", allowed write paths, and guarded irreversible commands
  const strList = (key) => {
    const v = data[key];
    if (v === undefined) return [];
    if (!Array.isArray(v) || v.some((x) => typeof x !== "string" || x.trim() === "")) { err(`\`${key}\` must be a list of non-empty strings`); return []; }
    return v;
  };
  node.checks = strList("checks");
  node.writes = data.writes === undefined ? null : strList("writes"); // [] means the playbook edits nothing
  node.guards = strList("irreversible");
  // Rails values differ per repository, so they come from the project through bindings.
  for (const [key, list] of [["checks", node.checks], ["writes", node.writes || []], ["irreversible", node.guards]]) {
    for (const x of list) if (!bindingNames(x).size) err(`\`${key}\` entry \`${x}\` is a literal; rails values belong to the project: write \`\${name}\` and declare name in bindings.md`);
  }
  // Check patterns against step text with every binding standing for itself.
  const self = { get: (name) => [`\${${name}}`] };
  for (const g of node.guards) {
    try { commandMatches(resolveText(g, self), ""); } catch { err(`irreversible pattern ${g} is not a valid regular expression`); }
  }
  if (node.guards.length && node.irreversibleSteps === 0) err("declares `irreversible` commands but has no [irreversible] step");
  for (const g of node.guards) {
    let hit = false;
    try { hit = steps.some((s) => s.irreversible && commandMatches(resolveText(g, self), s.text)); } catch { hit = true; }
    if (node.irreversibleSteps && !hit) warn(`irreversible pattern \`${g}\` appears in no [irreversible] step; name the command in the step so the runtime knows which gate guards it (while the irreversible steps wait for different gates, the hook refuses it)`);
  }
  // A command used in steps behind different gates (ramp stages) is told apart by each step's own
  // command, so every such step needs one, and an earlier stage's must not fit a later stage.
  for (const g of node.guards) {
    let pat, mentions;
    try { pat = resolveText(g, self); mentions = steps.filter((s) => s.irreversible && commandMatches(pat, s.text)); } catch { continue; }
    const gates = (s) => gatesBefore(steps, s.n);
    if (new Set(mentions.map(gates)).size < 2) continue;
    const bare = mentions.filter((s) => !stepCommands(s, pat).length);
    for (const s of bare) warn(`step ${s.n} names \`${g}\` only in prose, but the command runs in steps behind different gates; write it in backticks as the step runs it (\`${g} --stage <name>\`) so the runtime can tell which gate it needs`);
    for (const a of mentions) for (const b of mentions) {
      if (gates(a) >= gates(b) || bare.includes(b)) continue;
      const x = stepCommands(a, pat).find((c) => fitsStep(b, pat, c));
      if (x) warn(`step ${a.n}'s command \`${x}\` also fits step ${b.n}'s, so the runtime would hold it for step ${b.n}'s gate; make step ${b.n}'s command more specific`);
    }
  }

  if (data.exits !== undefined && !Array.isArray(data.exits)) err("exits must be a list");
  if (!node.terminal && node.exits.length === 0) err("non-terminal playbook needs at least one exit");
  for (const [n, e] of node.exits.entries()) {
    if (!e || typeof e !== "object" || !e.to) err(`exit #${n + 1} needs \`to\``);
    else if (typeof e.when !== "string" || e.when.trim() === "") err(`exit to "${e.to}" needs a \`when\` condition`);
    if (e && e.on !== undefined && !["pass", "fail"].includes(e.on)) err(`exit to "${e.to}": \`on\` must be pass or fail`);
  }
  if (node.exits.some((e) => e && e.on) && node.checks.length === 0) err("exits use `on` but the playbook has no `checks`");

  for (const s of REQUIRED_SECTIONS) {
    if (!secs.has(s)) err(`missing "## ${s}" section`);
    else if (secs.get(s).every((l) => l.trim() === "")) err(`"## ${s}" section is empty`);
  }
  if (secs.has("Steps") && steps.length === 0) err('"## Steps" has no numbered steps');
  const tagged = (secs.get("Steps") || []).filter((l) => /^\s*([-*+]|\s+\d+\.)\s/.test(l) && /\[(human-gate|irreversible)\]/i.test(l));
  for (const l of tagged) err(`[human-gate] and [irreversible] tag numbered steps only; this list item is not one: "${l.trim().slice(0, 80)}"`);

  // irreversible steps need a human gate earlier in the same playbook (or on the same step)
  let gated = false;
  for (const s of steps) {
    gated ||= s.humanGate;
    if (s.irreversible && !gated) err(`irreversible step without a preceding [human-gate]: "${s.text.slice(0, 80)}"`);
  }
  if (steps.length > 12) warn(`${steps.length} steps; consider splitting the playbook`);
  if (skillDir) {
    const hits = repoSpecific(body, skillDir, path.join(skillDir, "playbooks"));
    if (hits.length) warn(`${hits.map((h) => `\`${h}\``).join(", ")} ${hits.length > 1 ? "look" : "looks"} repository-specific; use a binding (\`\${name}\` declared in bindings.md) so the skill works in any repository`);
  }
  node.bindings = [...bindingNames(text.slice(0, text.length - body.length)), ...bindingNames(body)];
  return { node, errors, warnings };
}
