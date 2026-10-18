// Choice dialogs the agent shows the user (Claude Code's AskUserQuestion): the user's pick answers
// a waiting gate or suspend request, as their chat reply would, so they can tap instead of type.
// The agent writes the question, but only the dialog fills in the answer, so:
//   - a dialog for a waiting question that already carries answers is refused;
//   - an answer counts only for the one call the pre-tool hook saw without answers (matched by its
//     tool_use_id), so a payload the agent could shape some other way never counts;
//   - a dialog that resolved itself (an idle timeout) is no answer.
// Anything this does not recognise (another agent, a changed payload) counts as no answer, and the
// question waits for the chat reply as before.

import { toolInput } from "./tools.mjs";
import { GATE, SUSPEND } from "./reply.mjs";

const ASK_TOOLS = new Set(["askuserquestion"]);
const isAsk = (input) => ASK_TOOLS.has(String(input.tool_name || input.toolName || "").toLowerCase());
const callId = (input) => input.tool_use_id || input.toolUseId || null;
const questions = (ti) => (Array.isArray(ti?.questions) ? ti.questions.filter((q) => q && typeof q.question === "string") : []);
const labels = (q) => (Array.isArray(q.options) ? q.options.map((o) => String(o?.label ?? o).trim().toLowerCase()).join("|") : "");

// Which waiting question a dialog question asks, by its options: exactly the gate's choices, or
// the suspend request's.
function kindOf(q, state) {
  const l = labels(q);
  if (state.run?.awaiting && l === GATE.join("|").toLowerCase()) return "gate";
  if (state.request && l === SUSPEND.join("|").toLowerCase()) return "suspend";
  return null;
}

// Before the dialog shows: { deny } to refuse it, { save: true } when it is recorded, or null.
export function beforeAsk(input, state) {
  if (!isAsk(input) || state.suspended) return null;
  const ti = toolInput(input);
  const asked = questions(ti).map((q) => ({ question: q.question, kind: kindOf(q, state) })).filter((x) => x.kind);
  if (!asked.length) return null;
  if (ti.answers && typeof ti.answers === "object" && Object.keys(ti.answers).length) {
    return { deny: "this dialog asks the user a waiting question but already carries answers. Only the user answers it: ask again without `answers`." };
  }
  const id = callId(input);
  if (!id) return null;
  state.asked = { id, questions: asked };
  return { save: true };
}

// After the user answered: the answers to the recorded call, as [{ kind, text }], or null when
// the call is not the recorded one.
export function afterAsk(input, state) {
  if (!isAsk(input) || !state.asked || callId(input) !== state.asked.id) return null;
  const { questions: asked } = state.asked;
  state.asked = null;
  let res = input.tool_response ?? input.toolResponse ?? input.tool_result;
  if (typeof res === "string") { try { res = JSON.parse(res); } catch { res = null; } }
  if (!res || typeof res !== "object" || Object.keys(res).some((k) => /auto|idle|time/i.test(k))) return [];
  const answers = res.answers && typeof res.answers === "object" ? res.answers : {};
  return asked.map(({ question, kind }) => ({ kind, text: answers[question] })).filter((x) => typeof x.text === "string" && x.text.trim());
}
