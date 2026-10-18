// The runtime's commands, run against fresh state. Shared by the command line and the MCP server.

import os from "node:os";
import { skillName, now, Stop, refuse } from "./env.mjs";
import { openStore } from "./store.mjs";
import { loadGraph } from "./graph.mjs";
import { needRun, approve, reject, cmdStart, cmdStep, cmdFinish, cmdExit, cmdLog } from "./run.mjs";
import { statusText } from "./status.mjs";
import { install } from "./install.mjs";

// Who runs a command in their own terminal; a container may have no user name to give.
const terminalUser = () => { try { return os.userInfo().username || "the user (terminal)"; } catch { return "the user (terminal)"; } };

// Run one command against fresh state. Returns { code, text }; never prints.
export function execute(cmd, pos, o, root) {
  const st = openStore(root);
  const state = st.load();
  const g = loadGraph(root);
  try {
    if (cmd === "install") return { code: 0, text: install(root, o) };
    if (cmd === "log") return { code: 0, text: cmdLog(st) };
    if (cmd === "status") return { code: 0, text: o.json ? JSON.stringify({ skill: skillName, ok: g.ok, errors: g.errors, ...state }, null, 2) : statusText(g, state, root) };
    if (!g.ok) refuse(`the workflow graph is invalid; fix it before running:\n${g.errors.join("\n")}`);
    let extra = "";
    switch (cmd) {
      case "start": cmdStart(g, state, st, pos, o); break;
      case "step": try { cmdStep(g, state, st, pos, o); } finally { st.save(state); } break;
      case "finish": extra = cmdFinish(g, state, st, pos, o, root); break;
      case "exit": cmdExit(g, state, st, pos, o); break;
      case "pause": needRun(state).paused = { note: o.note || "no note", at: now() }; st.log({ event: "pause", run: state.run.id, note: o.note }); break;
      case "resume": needRun(state).paused = null; st.log({ event: "resume", run: state.run.id }); break;
      case "approve": { const n = approve(state, o.by || terminalUser(), o.note); st.log({ event: "approve", run: state.run.id, step: n, by: o.by || "cli" }); break; }
      case "reject": { const n = reject(state, o.by || terminalUser(), o.reason); st.log({ event: "reject", run: state.run.id, step: n, reason: o.reason }); break; }
      default: throw new Stop(`unknown command "${cmd}"; run \`flow help\``, 2);
    }
    st.save(state);
    return { code: 0, text: [extra, statusText(g, state, root)].filter(Boolean).join("\n") };
  } catch (e) {
    if (!(e instanceof Stop)) throw e;
    return { code: e.code, text: e.code === 3 ? e.message : `REFUSED: ${e.message}` };
  }
}
