// Choice dialogs the agent shows the user while a question waits for them (Claude Code's
// AskUserQuestion): the user's pick is kept like a message they sent, so the agent can record it
// with `flow answer`. The agent writes the question, but only the dialog fills in the answer, so:
//   - a dialog that already carries answers is refused while a question waits;
//   - a pick is kept only for the one call the pre-tool hook saw without answers (matched by its
//     tool_use_id), so a payload the agent could shape some other way never counts;
//   - a dialog that resolved itself (an idle timeout) is no pick.
// A dialog this does not recognise (another agent, a changed payload) keeps nothing; the user's
// reply in the chat still counts.

import { toolInput } from "./tools.mjs";

const isAsk = (input) => String(input.tool_name || input.toolName || "").toLowerCase() === "askuserquestion";
const callId = (input) => input.tool_use_id || input.toolUseId || null;
const waiting = (state) => !state.suspended && !!(state.request || state.run?.awaiting);

// Before the dialog shows: { deny } to refuse it, { save: true } when it is recorded, or null.
export function beforeAsk(input, state) {
  if (!isAsk(input) || !waiting(state)) return null;
  const ti = toolInput(input);
  if (ti.answers && typeof ti.answers === "object" && Object.keys(ti.answers).length) {
    return { deny: "this dialog already carries answers, and a question waits for the user. Only the user answers it: ask again without `answers`." };
  }
  const id = callId(input);
  if (!id) return null;
  state.asked = id;
  return { save: true };
}

// After the dialog: the user's picks for the recorded call, as "question: answer" lines, or null
// when the call is not the recorded one.
export function afterAsk(input, state) {
  if (!isAsk(input) || !state.asked || callId(input) !== state.asked) return null;
  state.asked = null;
  let res = input.tool_response ?? input.toolResponse ?? input.tool_result;
  if (typeof res === "string") { try { res = JSON.parse(res); } catch { res = null; } }
  if (!res || typeof res !== "object" || Object.keys(res).some((k) => /auto|idle|time/i.test(k))) return [];
  const answers = res.answers && typeof res.answers === "object" ? res.answers : {};
  return Object.entries(answers).filter(([, a]) => typeof a === "string" && a.trim()).map(([q, a]) => `${q}: ${a}`);
}
