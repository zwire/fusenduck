// How the agent asks the user a question only they can answer (may a [human-gate] pass, may the
// rails be suspended). The user answers as they would anyone: a choice in the agent's question
// dialog, or a reply in their own words. The agent reads what they meant and records it with
// `flow answer`, quoting them; the rails never parse the words. They hold the record to what the
// user sent: the quote must come from a message the user sent after the question was asked
// (flow.mjs keeps those), so the agent cannot answer before the user has, or in words they did not write.

const how = (f, verbs, choices) => `with your choice tool if you have one (${choices}), or in plain words, and end your turn. When the user answers, record what they meant with \`${f} answer ${verbs} --quote "<their words>"\`, quoting their reply; only words they sent after you asked are accepted, and nothing counts until they answer`;
export const askAtGate = (n = "<n>", f = "flow") => `ask the user whether step ${n} may pass, ${how(f, "approve|reject", "Approve / Reject")}`;
export const askSuspend = (f = "flow") => `ask the user whether to suspend the rails for that, ${how(f, "suspend|decline", "Suspend / Keep the rails on")}`;
