// The profile (profile.md): the axes of the developer's style and domain, and the rules from
// references/composition.md that tie them to the graph.

import fs from "node:fs";
import path from "node:path";
import { SCHEMA, VERSION, PROFILE_AXES, LIST_AXES, NAME_RE } from "./contract.mjs";
import { parseFrontmatter, sections } from "./frontmatter.mjs";

export function readProfile(dir, err, warn) {
  const where = "profile.md";
  const p = path.join(dir, "profile.md");
  if (!fs.existsSync(p)) { warn(where, "missing; profile-to-graph consistency checks skipped"); return null; }
  const { data, body, problems } = parseFrontmatter(fs.readFileSync(p, "utf8"));
  for (const pr of problems) err(where, pr);
  if (!data) {
    err(where, `no frontmatter; schema ${SCHEMA} keeps the profile axes there (see references/graph-model.md#schema-versions)`);
    return null;
  }
  if (data.schema === undefined) err(where, "frontmatter `schema` is required");
  else if (typeof data.schema !== "number") err(where, "`schema` must be a number");
  else if (data.schema > SCHEMA) err(where, `written for schema ${data.schema}; this validator (vajra ${VERSION}) supports schema ${SCHEMA}. Update vajra`);
  else if (data.schema < SCHEMA) err(where, `schema ${data.schema} is outdated; run vajra Evolve to migrate to schema ${SCHEMA}`);
  if (!data.generator) warn(where, "frontmatter `generator` is missing (expected vajra@<version>)");
  for (const [axis, values] of Object.entries(PROFILE_AXES)) {
    const v = data[axis];
    if (v === undefined || v === "") { warn(where, `axis \`${axis}\` is missing`); continue; }
    if (LIST_AXES.has(axis)) {
      if (!Array.isArray(v)) { err(where, `\`${axis}\` must be a list like [a, b]`); continue; }
      for (const x of v) {
        if (values ? !values.includes(x) : !(typeof x === "string" && NAME_RE.test(x))) {
          err(where, `\`${axis}\` value "${x}" must be ${values ? `one of ${values.join("|")}` : "lowercase-hyphenated"}`);
        }
      }
      if (axis === "journey" && v.length === 0) err(where, "`journey` needs at least one phase");
    } else if (!values.includes(v)) err(where, `\`${axis}\` must be one of ${values.join("|")}`);
  }
  const model = sections(body).get("Domain model");
  if (!model || model.every((l) => l.trim() === "")) warn(where, "no `## Domain model` section; describe this domain's areas, evidence ladder and irreversible actions in concrete terms");
  return data;
}

// Rules from references/composition.md that can be checked mechanically. Generated skills may
// deviate on purpose, so these are warnings; the reason belongs in profile.md "Composition notes".
export function checkComposition(profile, skillFm, nodes, err, warn) {
  const list = [...nodes.values()];
  const promotes = list.filter((n) => n.promotes).map((n) => n.promotes);
  const lifecycles = new Set(list.map((n) => n.lifecycle));
  const journey = new Set(Array.isArray(profile.journey) ? profile.journey : []);
  const where = "profile.md";

  if (profile.invocation === "explicit" && skillFm?.description && !/\binvoke|\bby name\b|\bexplicitly\b/i.test(skillFm.description)) {
    warn("SKILL.md", "profile invocation is explicit but the description does not say to run only when invoked by name");
  }
  if (journey.size) {
    if (journey.has("explore") && (journey.has("expand") || journey.has("extract")) && !promotes.some(([f]) => f === "throwaway")) {
      warn(where, "journey leaves explore but no gate promotes from throwaway");
    }
    if (journey.has("extract") && !promotes.some(([, t]) => t === "hardened")) warn(where, "journey includes extract but no gate promotes to hardened");
    if (!journey.has("extract") && lifecycles.has("hardened")) warn(where, "hardened playbooks exist but journey lacks extract");
    if (!journey.has("explore") && lifecycles.has("throwaway")) warn(where, "throwaway playbooks exist but journey lacks explore");
  }
  if (profile.failure_cost === "regulated") {
    for (const n of list) if (n.promotes && n.humanGates === 0) warn(`playbooks/${n.id}.md`, "failure_cost is regulated; every promotion gate needs a [human-gate] step");
  }
  const facets = new Set(Array.isArray(profile.facets) ? profile.facets : []);
  const rails = profile.rails;
  if (rails && rails !== "advisory") {
    if (facets.has("physical-world")) for (const n of list) if (!n.writes) warn(`playbooks/${n.id}.md`, "declares no `writes`, so it may edit any file, the safety limits included; list the paths it edits, or `writes: []` if it edits none");
    for (const n of list) if (n.irreversibleSteps > 0 && n.guards.length === 0) warn(`playbooks/${n.id}.md`, "has [irreversible] steps but declares no `irreversible` command patterns, so the hooks cannot block them");
  }
  if (profile.hardware && profile.hardware !== "none" && !facets.has("physical-world")) warn(where, `hardware is ${profile.hardware} but facets lack physical-world`);
  if (facets.has("physical-world") && rails === "advisory") warn(where, "physical-world needs rails: standard or strict");
  if (profile.failure_cost === "regulated" && rails && rails !== "strict") warn(where, "failure_cost is regulated; use rails: strict");
  if (["test-after", "tdd", "formal"].includes(profile.verification)) {
    for (const n of list) {
      if (n.kind === "work" && ["tracer", "hardened"].includes(n.lifecycle) && n.checks.length === 0) {
        warn(`playbooks/${n.id}.md`, `verification is ${profile.verification} but this kept-code playbook has no \`checks\``);
      }
    }
  }
  const anyIrreversible = list.some((n) => n.irreversibleSteps > 0);
  if (profile.hardware && profile.hardware !== "none" && !anyIrreversible) warn(where, `hardware is ${profile.hardware} but no step is tagged [irreversible]`);
  if (journey.has("extract") && ["customer", "regulated"].includes(profile.failure_cost) && !anyIrreversible) {
    warn(where, "journey reaches production for customers but no step is tagged [irreversible] (deploys, migrations)");
  }
}
