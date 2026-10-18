// Run transitions, shared by the CLI, the hooks and the MCP server: entering a playbook, recording
// steps, interrupting at human gates, running checks and taking exits.

import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { now, RESOLVED, Stop, refuse } from "./env.mjs";
import { commandMatches, fitsStep, gatesBefore } from "./match.mjs";
import { askAtGate } from "./reply.mjs";

function enterPlaybook(node) {
  return {
    playbook: node.id,
    enteredAt: now(),
    steps: Object.fromEntries(node.steps.map((s) => [s.n, { status: "pending" }])),
    awaiting: null,
    checks: null,
    finished: null,
  };
}

const gateText = (s) => s.text.replace(/\[human-gate\]\s*/i, "");

// Earliest [human-gate] before step n that the human has not approved.
export function blockingGate(node, run, n) {
  for (const s of node.steps) {
    if (s.n >= n) break;
    if (s.humanGate && run.steps[s.n]?.status !== "done") return s;
  }
  return null;
}

// The [irreversible] step a guarded command belongs to, so the gates before that step must be
// approved. When the steps that could own it wait for different gates (a ramp to 1% after one gate,
// to 50% after another), the command is matched against each step's own command, and of those it
// fits the one behind the most gates wins, so a later stage never passes on an earlier stage's
// approval. A command that fits none of them, or that no step names, returns null: the hook refuses
// it rather than guess.
export function guardedStep(node, run, pat, line) {
  const irr = node.steps.filter((s) => s.irreversible);
  const mentions = irr.filter((s) => { try { return commandMatches(pat, s.text); } catch { return false; } });
  const pool = mentions.length ? mentions : irr;
  const pick = (list) => list.find((s) => run.steps[s.n]?.status === "pending") || list[list.length - 1];
  if (new Set(pool.map((s) => gatesBefore(node.steps, s.n))).size <= 1) return pick(pool);
  if (!mentions.length) return null;
  const fits = mentions.filter((s) => fitsStep(s, pat, line));
  if (!fits.length) return null;
  const most = Math.max(...fits.map((s) => gatesBefore(node.steps, s.n)));
  return pick(fits.filter((s) => gatesBefore(node.steps, s.n) === most));
}

export function allowedExits(node, run) {
  if (!run.finished) return [];
  const result = run.checks && !run.checks.pass ? "fail" : "pass";
  const exits = node.exits.filter((e) => (e.on || "pass") === result);
  if (node.terminal && result === "pass" && !exits.some((e) => e.to === "end")) exits.push({ to: "end", when: "the playbook is terminal and its Done when holds" });
  return exits;
}

export function approve(state, by, note) {
  const run = state.run;
  if (!run?.awaiting) refuse("no human gate is waiting; the agent reaches it with `flow step <n>` first");
  const n = run.awaiting.step;
  run.steps[n] = { status: "done", evidence: `approved by ${by}${note ? `: ${note}` : ""}`, approvedBy: by, at: now() };
  run.awaiting = null;
  return n;
}

export function reject(state, by, reason) {
  const run = state.run;
  if (!run?.awaiting) refuse("no human gate is waiting");
  const n = run.awaiting.step;
  run.steps[n] = { status: "rejected", reason: `rejected by ${by}: ${reason || "no reason given"}`, at: now() };
  for (const [k, st] of Object.entries(run.steps)) if (Number(k) > n && st.status === "pending") run.steps[k] = { status: "skipped", reason: "gate rejected" };
  run.awaiting = null;
  return n;
}

// ---------- commands ----------

export function needRun(state) {
  if (!state.run) refuse("no playbook is active; start one with `flow start <playbook> --request \"...\"`");
  return state.run;
}

export function cmdStart(g, state, st, [id], o) {
  if (!id) throw new Stop("usage: flow start <playbook> --request \"<one line>\"", 2);
  if (g.unbound.length) refuse(`this project has not bound ${g.unbound.join(", ")}; ask the user to write them in ${g.projectFile} (what each one means is in the skill's bindings.md)`);
  if (state.run) {
    if (!o.abandon) refuse(`a run is active (playbook ${state.run.playbook}). Finish it and take an exit, or pass --abandon "<reason>"`);
    st.log({ event: "abandon", run: state.run.id, playbook: state.run.playbook, reason: o.abandon });
    st.archive({ ...state.run, abandoned: { reason: o.abandon, at: now() } });
    state.run = null;
  }
  if (!g.nodes.has(id)) refuse(`no playbook "${id}"`);
  if (!g.entries.includes(id)) refuse(`"${id}" is not a router entry; start at one of: ${g.entries.join(", ")}`);
  if (!o.request) refuse("--request \"<one line>\" is required: say what this run is for");
  const node = g.nodes.get(id);
  state.run = { id: `${now().replace(/[-:]/g, "").replace(/\..*/, "")}-${Math.random().toString(36).slice(2, 6)}`, request: o.request, startedAt: now(), paused: null, history: [], ...enterPlaybook(node) };
  st.log({ event: "start", run: state.run.id, playbook: id, request: o.request });
}

export function cmdStep(g, state, st, [nArg], o) {
  const run = needRun(state);
  if (run.paused) refuse("the run is paused; `flow resume` first");
  const node = g.nodes.get(run.playbook);
  const n = Number(nArg);
  const s = node.steps[n - 1];
  if (!s) throw new Stop(`usage: flow step <1-${node.steps.length}> --evidence "..." | --skip "..."`, 2);
  const gate = blockingGate(node, run, n);
  if (gate) refuse(`step ${gate.n} is a human gate that has not been approved; steps after it wait for the human`);
  if (s.humanGate) {
    if (o.skip) refuse("a human gate cannot be skipped");
    if (run.steps[n].status === "done") refuse(`step ${n} is already approved`);
    if (run.steps[n].status === "rejected") refuse(`step ${n} was rejected; finish the playbook and take the exit that fits`);
    run.awaiting = { step: n, since: now() };
    st.log({ event: "await", run: run.id, playbook: node.id, step: n });
    throw new Stop(`STOP. Step ${n} is a human gate: "${gateText(s)}"\nPresent what the user needs to decide, then ${askAtGate(n)}. Only the user can pass it (or run \`flow approve\` themselves).`, 3);
  }
  if (!o.evidence && !o.skip) throw new Stop(`usage: flow step ${n} --evidence "<what shows it>" | --skip "<reason>"`, 2);
  run.steps[n] = o.skip ? { status: "skipped", reason: o.skip, at: now() } : { status: "done", evidence: o.evidence, at: now() };
  if (run.finished) { run.finished = null; run.checks = null; }
  st.log({ event: o.skip ? "skip" : "step", run: run.id, playbook: node.id, step: n, text: o.skip || o.evidence });
}

export function cmdFinish(g, state, st, _args, o, root) {
  const run = needRun(state);
  if (run.paused) refuse("the run is paused; `flow resume` first");
  if (run.awaiting) refuse(`step ${run.awaiting.step} is waiting for the human`);
  const node = g.nodes.get(run.playbook);
  const pending = node.steps.filter((s) => !RESOLVED.has(run.steps[s.n].status));
  if (pending.length) refuse(`steps ${pending.map((s) => s.n).join(", ")} are not recorded; record each with --evidence or --skip "<reason>"`);
  if (!o.evidence) refuse("--evidence \"<what proves Done when>\" is required");
  const results = node.checks.map((cmd) => {
    const r = spawnSync(cmd, { cwd: root, shell: true, encoding: "utf8", timeout: 15 * 60 * 1000 });
    const out = `${r.stdout || ""}${r.stderr || ""}`.trim().split("\n").slice(-15).join("\n");
    return { cmd, code: r.status ?? 1, tail: out };
  });
  run.checks = results.length ? { pass: results.every((r) => r.code === 0), results, at: now() } : null;
  run.finished = { evidence: o.evidence, at: now() };
  st.log({ event: "finish", run: run.id, playbook: node.id, evidence: o.evidence, checks: results.map(({ cmd, code }) => ({ cmd, code })) });
  return results.map((r) => `check ${r.code === 0 ? "pass" : "FAIL"}: ${r.cmd}${r.code === 0 ? "" : `\n${r.tail.replace(/^/gm, "    ")}`}`).join("\n");
}

export function cmdExit(g, state, st, [to], o) {
  const run = needRun(state);
  if (run.paused) refuse("the run is paused; `flow resume` first");
  const node = g.nodes.get(run.playbook);
  if (!run.finished) refuse(`${node.id} is not finished; run \`flow finish --evidence "..."\` first`);
  const allowed = allowedExits(node, run);
  const exit = allowed.find((e) => e.to === to);
  if (!exit) {
    const why = run.checks && !run.checks.pass ? " (checks failed, so only exits marked `on: fail` are open)" : "";
    refuse(`"${to}" is not an open exit from ${node.id}${why}. Open exits: ${allowed.map((e) => `${e.to} — ${e.when}`).join("; ") || "none"}`);
  }
  if (!o.because) refuse(`--because is required: show why "${exit.when}" holds`);
  run.history.push({ playbook: node.id, to, when: exit.when, because: o.because, checks: run.checks ? run.checks.pass : null, at: now() });
  st.log({ event: "exit", run: run.id, from: node.id, to, because: o.because });
  if (to === "end") {
    st.archive({ ...run, endedAt: now() });
    state.run = null;
    return;
  }
  Object.assign(run, enterPlaybook(g.nodes.get(to)));
}

export function cmdLog(st) {
  const file = path.join(st.dir, "log.jsonl");
  if (!fs.existsSync(file)) return "(no events yet)";
  return fs.readFileSync(file, "utf8").trim().split("\n").slice(-40).map((l) => {
    const e = JSON.parse(l);
    const { at, event, ...rest } = e;
    return `${at}  ${event.padEnd(8)} ${Object.entries(rest).map(([k, v]) => `${k}=${typeof v === "string" ? v : JSON.stringify(v)}`).join(" ")}`;
  }).join("\n");
}
