// The human answers a question the rails ask (may a [human-gate] pass, may the rails be suspended)
// by picking one of its choices: in the agent's choice dialog (ask.mjs), in an elicitation dialog
// (mcp.mjs), or in the chat by its number or its name, with anything after it kept as a note
// ("1", "approve, ship it", "2: not today"). Nothing else in a message is read, so nothing is guessed.

export const GATE = ["Approve", "Reject"];
export const SUSPEND = ["Suspend", "Reject"];

// The choice a message picks, as { choice, rest }, or null. Numbers can be turned off when two
// questions wait at once and "1" would not say which.
export function pick(text, choices, { numbers = true } = {}) {
  const t = String(text ?? "").normalize("NFKC").trim();
  for (const [i, c] of choices.entries()) {
    const m = t.match(new RegExp(`^(?:${numbers ? `${i + 1}|` : ""}${c})(?:[\\s:,.!)-]+([\\s\\S]*))?$`, "i"));
    if (m) return { choice: c, rest: (m[1] || "").trim() };
  }
  return null;
}

// A prompt the agent hands to another session must not pick a choice there (see protect.mjs).
export const readsAsReply = (text) => !!(pick(text, GATE) || pick(text, SUSPEND));

const listed = (choices) => choices.map((c, i) => `${i + 1}. ${c}`).join("  ");
const asChoice = (choices) => `as a choice: with your choice tool if you have one (Claude Code: AskUserQuestion with exactly the options ${choices.join(" and ")}, and no answers of your own), otherwise by ending your message with "${listed(choices)}". The user picks one; only their pick counts`;
export const askAtGate = (n = "<n>") => `ask the user whether step ${n} may pass, ${asChoice(GATE)}`;
export const askSuspend = `ask the user whether to suspend the rails for that, ${asChoice(SUSPEND)}`;
