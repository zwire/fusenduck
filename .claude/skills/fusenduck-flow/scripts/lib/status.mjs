// What the agent is told about the run: the next move, the injected context and `flow status`.

import { tag, RESOLVED, flowCmd } from "./env.mjs";
import { allowedExits } from "./run.mjs";
import { askAtGate, askSuspend } from "./reply.mjs";

export function nextHint(node, run, root) {
  const f = flowCmd(root);
  if (run.paused) return `the run is paused (${run.paused.note}); continue with \`${f} resume\``;
  if (run.awaiting) return `waiting for the human at step ${run.awaiting.step}; stop and ${askAtGate(run.awaiting.step, f)}`;
  const pending = node.steps.find((s) => run.steps[s.n].status === "pending");
  if (pending) {
    return pending.humanGate
      ? `step ${pending.n} is a human gate: run \`${f} step ${pending.n}\`, then stop and ask the user`
      : `do step ${pending.n}, then \`${f} step ${pending.n} --evidence "..."\``;
  }
  if (!run.finished) return `every step is recorded; run \`${f} finish --evidence "<what proves Done when>"\``;
  const exits = allowedExits(node, run);
  if (!exits.length) return `checks failed and no exit handles failure; fix the cause and run \`${f} finish\` again`;
  return `take one exit: ${exits.map((e) => `\`${f} exit ${e.to} --because "..."\` when ${e.when}`).join("; ")}`;
}

export function describe(g, state, root) {
  const text = describeState(g, state, root);
  if (!state.request || state.suspended) return text;
  return `${text}\n${tag} Waiting for the user to answer your request to suspend the rails so you can ${state.request.reason}: ${askSuspend(flowCmd(root))}.`;
}

// How the agent asks to change what only a suspended rail lets it change.
export const askToSuspend = (root, why = "<what you will change>") => `run \`${flowCmd(root)} request suspend --reason "${why}"\`, then stop and ${askSuspend(flowCmd(root))}`;

function describeState(g, state, root) {
  if (!g.ok) return `${tag} The workflow graph is invalid, so the rails are off until it validates: ${g.errors[0]}. To repair the skill, ${askToSuspend(root, "<what you will repair>")}.`;
  if (state.suspended) return `${tag} Rails suspended by the user: nothing is enforced. When the change that needed it is done, run \`${flowCmd(root)} unsuspend\`.`;
  const run = state.run;
  if (g.unbound.length) {
    const what = g.unbound.map((n) => `${n} (${g.bindings[n] || "not declared in bindings.md"})`).join("; ");
    const guards = g.unboundGuards.length ? ` Guarded commands that use ${g.unboundGuards.map((n) => `\${${n}}`).join(", ")} are not recognized either, so ask before anything irreversible.` : "";
    const note = `${tag} This project has not bound ${what}. Ask the user for the values, or propose them from the repository; until ${g.projectFile} has them, no run can start. It is part of the rails: to write it, ${askToSuspend(root, "write the project bindings")}.${guards}`;
    if (!run) return note;
    return `${note}\n${describeRun(g, state, root)}`;
  }
  if (!run) {
    const how = `match it to a playbook in SKILL.md and run \`${flowCmd(root)} start <playbook> --request "<one line>"\``;
    // An explicit skill must not pull unrelated work onto its rails; strict rails need a run to edit at all.
    if (g.profile.invocation === "explicit" && g.profile.rails !== "strict") return `${tag} No playbook is active. Use this workflow only when the user asks for it by name; then ${how}. Other work needs no playbook.`;
    return `${tag} No playbook is active. To work on a task with this workflow, ${how}.`;
  }
  return describeRun(g, state, root);
}

function describeRun(g, state, root) {
  const run = state.run;
  const node = g.nodes.get(run.playbook);
  const done = node.steps.filter((s) => RESOLVED.has(run.steps[s.n].status)).length;
  return `${tag} Active playbook: ${node.id} (${done}/${node.steps.length} steps recorded) for "${run.request}". Next: ${nextHint(node, run, root)}.`;
}

export function statusText(g, state, root) {
  const lines = [describe(g, state, root)];
  const run = state.run;
  if (!g.ok || !run) return lines.join("\n");
  const node = g.nodes.get(run.playbook);
  lines.push("", `Playbook ${node.id} — ${node.title} (${node.phase} · ${node.lifecycle} · ${node.kind}): playbooks/${node.id}.md`);
  const mark = { pending: "[ ]", done: "[x]", skipped: "[-]", rejected: "[!]" };
  for (const s of node.steps) {
    const st = run.steps[s.n];
    const waiting = run.awaiting?.step === s.n;
    const note = waiting ? "  ← waiting for the human" : st.evidence ? `  — ${st.evidence}` : st.reason ? `  — ${st.reason}` : "";
    lines.push(`  ${waiting ? "[?]" : mark[st.status]} ${s.n}. ${s.text}${note}`);
  }
  const bound = node.used.filter(([, v]) => v);
  if (bound.length) lines.push(`Bindings (from ${g.projectFile}): ${bound.map(([b, v]) => `\${${b}} = ${v.map((x) => `\`${x}\``).join(", ")}`).join("; ")}`);
  if (node.checks.length) lines.push(`Checks: ${node.checks.map((c) => `\`${c}\``).join(", ")}${run.checks ? ` → ${run.checks.pass ? "pass" : "FAIL"}` : ""}`);
  lines.push(`Exits: ${node.exits.map((e) => `${e.to}${e.on ? ` [on ${e.on}]` : ""} — ${e.when}`).join("; ") || "(terminal)"}`);
  if (run.history.length) lines.push(`Path so far: ${run.history.map((h) => h.playbook).join(" → ")} → ${node.id}`);
  return lines.join("\n");
}
