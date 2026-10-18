// The lifecycle hooks, the same for every agent: what to inject at session start and on prompts,
// which tool calls to refuse, and when to bounce a stop. How a tool call is read is in tools.mjs,
// shell.mjs, protect.mjs and settings.mjs. runHook returns what to answer; flow.mjs writes it in
// the agent's format, so the answer has one shape whichever part of the runtime produced it.

import os from "node:os";
import path from "node:path";
import { skillDir, tag, relPath, railsLevel, flowCmd } from "./env.mjs";
import { globToRegExp, stepCommands } from "./match.mjs";
import { guardMatches } from "./shell.mjs";
import { toolAction } from "./tools.mjs";
import { shellViolation, codeTouchesRails } from "./protect.mjs";
import { askAtGate } from "./reply.mjs";
import { beforeAsk, afterAsk } from "./ask.mjs";
import { dropsHooks, railsPaths, inside, samePath } from "./settings.mjs";
import { openStore } from "./store.mjs";
import { loadGraph } from "./graph.mjs";
import { blockingGate, guardedStep, approve, reject } from "./run.mjs";
import { describe, nextHint, askToSuspend } from "./status.mjs";

const railsMsg = (root) => `the workflow's own rules (its playbooks, profile and scripts) and the hooks that enforce them change only while the rails are suspended, which only the user can allow. If the change is needed, ${askToSuspend(root)}.`;

const STATE_MSG = "the run state and project bindings in .flow/ are changed only through flow.mjs or by the user (reading them with cat, jq, grep or Get-Content is fine; or try `flow status` or `flow log`).";
const SHELL_MSG = {
  human: (root) => `only the user can approve, reject or suspend, and flow.mjs hook and mcp are run by the agent harness, not from the shell. At a human gate, stop and ${askAtGate("<n>", flowCmd(root))}. To change the workflow's own files, ${askToSuspend(root)}.`,
  rails: railsMsg,
  agent: () => "the user's answer to a waiting question is a message they send, and a prompt handed to another agent session (or scheduled, or sent to one) arrives there as such a message, since its hooks are this workflow's. Wait until the user has answered, then start it.",
  complex: "this command nests shells or scripts too deeply for the rails to check. Run it as simpler, separate commands.",
  clean: "git clean -x would delete the run state in .flow/; clean without -x/-X, or ask the user.",
  state: STATE_MSG,
};

// Checks that protect the rails themselves: the run state, the project bindings, the skill, the
// hook settings and the human-only commands. They need no graph, so they hold even while the
// graph is invalid.
function railsCheck(act, g, root, cwd, waiting) {
  const rp = railsPaths(root, skillDir);
  const ctx = { root, cwd, skillDir, waiting };
  const pathCheck = (abs, change) => {
    const rel = relPath(root, abs);
    if (samePath(rel, g.projectFile)) return `the project bindings in ${g.projectFile} are part of the rails; they change only while the rails are suspended, which only the user can allow. Ask the user for the values, or propose them from the repository. If the change is needed, ${askToSuspend(root)}.`;
    if (/^\.flow(\/|$)/i.test(rel)) return "the run state is written only by flow.mjs.";
    if (inside(abs, rp.skill)) return railsMsg(root);
    if ((rp.configs.some((q) => samePath(q, abs)) || inside(abs, rp.hookDir)) && (!change || dropsHooks(abs, { change }))) return railsMsg(root);
    return null;
  };
  if (act.kind === "edit") {
    if (!act.paths.length) return "this edit names no file the rails can find, so it cannot be checked. Use the agent's own edit or write tool with a file path.";
    for (const fp of act.paths) { const r = pathCheck(path.resolve(cwd, fp), act.change); if (r) return r; }
    return null;
  }
  for (const line of act.lines || []) {
    const v = shellViolation(line.command, line.ps, ctx);
    if (v) return typeof SHELL_MSG[v] === "function" ? SHELL_MSG[v](root) : SHELL_MSG[v];
  }
  if (act.kind !== "other" || act.readOnly) return null;
  if (waiting && act.prompts.length) return SHELL_MSG.agent(root);
  if (act.code.some((c) => codeTouchesRails(c, ctx))) return `${STATE_MSG} The same holds for the workflow's own files and hook settings.`;
  for (const { text: t, context } of act.values) {
    const abs = path.resolve(cwd, t.replace(/^~(?=\/|\\|$)/, os.homedir()));
    // An unknown tool may write any path it is given, and one that deletes takes what is below it.
    const r = pathCheck(abs, null) || (act.deletes && !context && [rp.state, rp.skill, rp.hookDir, ...rp.configs].some((q) => inside(q, abs)) ? railsMsg(root) : null);
    if (r) return r;
  }
  return null;
}

function preToolUse(g, state, input, root, opts) {
  const rails = railsLevel(g);
  if (state.suspended || (g.ok && rails === "advisory")) return null;
  const act = toolAction(input, opts);
  const cwd = input.cwd || root;
  const own = railsCheck(act, g, root, cwd, !!(state.request || state.run?.awaiting));
  if (own || !g.ok) return own;
  const run = state.run;
  const f = flowCmd(root);

  if (act.kind === "edit") {
    for (const fp of act.paths) {
      const rel = relPath(root, path.resolve(cwd, fp));
      if (rel.startsWith("..")) continue;
      if (!run) { if (rails === "strict") return `no playbook is active, so edits are blocked. Match the task to a playbook and run \`${f} start <playbook> --request "..."\`.`; continue; }
      if (run.paused && rails === "strict") return `the run is paused; \`${f} resume\` before editing.`;
      if (run.paused) continue; // a paused run leaves the agent free for other work; guarded commands stay blocked
      const node = g.nodes.get(run.playbook);
      if (node.writes && !node.writes.some((w) => globToRegExp(w).test(rel))) {
        return `playbook ${node.id} ${node.writes.length ? `may only write ${node.writes.join(", ")}; ${rel} is outside` : `is read-only (\`writes: []\`), so it may not edit ${rel}`}. Finish the playbook and take an exit to one that owns this path.`;
      }
    }
    return null;
  }

  for (const { command: cmd, ps } of act.lines || []) {
    // Several playbooks may guard the same command; it runs only inside one of them.
    const owners = [...g.nodes.values()].map((node) => [node, node.guards.filter((pat) => guardMatches(pat, cmd, { ps }))]).filter(([, pats]) => pats.length);
    if (!owners.length) continue;
    const own = run && owners.find(([node]) => node.id === run.playbook);
    if (!own) {
      const ids = owners.map(([node]) => node.id).join(" or ");
      return `\`${owners[0][1][0]}\` is irreversible and runs only inside playbook ${ids}, after its human gate. Current playbook: ${run ? run.playbook : "none"}.`;
    }
    if (run.paused) return "the run is paused.";
    const [node, pats] = own;
    for (const pat of pats) {
      const step = guardedStep(node, run, pat, cmd);
      if (!step) {
        const forms = node.steps.filter((s) => s.irreversible).flatMap((s) => stepCommands(s, pat).map((x) => `step ${s.n}: \`${x}\``));
        return forms.length
          ? `\`${pat}\` runs in more than one step of ${node.id}, behind different gates, and this command matches none of them, so the rails cannot tell which gate it needs. Write it as its step does (${forms.join("; ")}).`
          : `\`${pat}\` is guarded in ${node.id}, but no step names it, so the rails cannot tell which gate it needs. Stop and ask the user; the playbook should name the command in its [irreversible] step.`;
      }
      const gate = blockingGate(node, run, step.n);
      if (gate) return `\`${pat}\` belongs to step ${step.n} and step ${gate.n} [human-gate] is not approved. Run \`${f} step ${gate.n}\`, then stop and ask the user.`;
    }
  }
  return null;
}

// A fingerprint of the run's progress: a stop is bounced once per fingerprint, so the agent is
// nudged after real progress but never trapped, whatever loop guard the harness provides.
const progress = (run) => JSON.stringify([run.playbook, run.steps, !!run.finished]);

function stopCheck(g, state, input, root) {
  const rails = railsLevel(g);
  const run = state.run;
  if (!g.ok || state.suspended || state.request || rails === "advisory" || !run || input.stop_hook_active || run.paused || run.awaiting) return null;
  if (run.nudged === progress(run)) return null;
  const node = g.nodes.get(run.playbook);
  const f = flowCmd(root);
  const pending = node.steps.filter((s) => run.steps[s.n].status === "pending");
  const where = pending.length
    ? `playbook ${node.id} is in progress; step${pending.length > 1 ? "s" : ""} ${pending.map((s) => s.n).join(", ")} not recorded`
    : !run.finished ? `playbook ${node.id} has every step recorded but is not finished` : `playbook ${node.id} is finished but no exit was taken`;
  run.nudged = progress(run);
  return `${where}. Next: ${nextHint(node, run, root)}. If you must stop (for example to ask the user something), run \`${f} pause --note "<why>"\` first.`;
}

// What a hook answers, or null for nothing:
//   { context: text, event }   context for the agent (event: the hook event name to report)
//   { heard: [text] }          what the user picked in a choice dialog, for flow.mjs to keep
//   { deny: reason }           refuse the tool call
//   { block: reason }          bounce the stop
// opts are passed to toolAction (which shell a Bash tool runs).
export function runHook(event, input, root, opts = {}) {
  const g = loadGraph(root);
  const st = openStore(root);
  const state = st.load();
  const event_ = input.hook_event_name || "SessionStart";
  if (event === "session-start") return { context: describe(g, state, root), event: event_ };
  // The user's own words are kept by flow.mjs for `flow answer`; nothing here reads them.
  if (event === "user-prompt") {
    // Without a run there is nothing to track on every prompt; session start already said how to begin.
    if (g.ok && !state.run && !state.suspended && !state.request && railsLevel(g) !== "strict") return null;
    return { context: describe(g, state, root), event: event_ };
  }
  if (event === "pre-tool-use") {
    const ask = beforeAsk(input, state);
    if (ask?.save) st.save(state);
    const reason = ask?.deny || preToolUse(g, state, input, root, opts);
    if (!reason) return null;
    st.log({ event: "block-tool", tool: input.tool_name, reason });
    return { deny: reason };
  }
  // The user's picks in a choice dialog, which flow.mjs keeps like their messages.
  if (event === "post-tool-use") {
    const heard = afterAsk(input, state);
    if (!heard) return null;
    st.save(state);
    return { heard };
  }
  if (event === "stop") {
    const reason = stopCheck(g, state, input, root);
    if (!reason) return null;
    st.save(state);
    st.log({ event: "block-stop", reason });
    return { block: reason };
  }
  return { unknown: event };
}
