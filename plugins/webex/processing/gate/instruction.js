// ********* PROCESSING/GATE/INSTRUCTION.JS *********
'use strict';

// v3 §4 tagging gate prompt. One tool call does two separate judgments —
// kept structurally apart below, not just in wording:
// - Tags on the current (most recent) message: isAddressed, configRequest.
// - A readiness decision on the whole batch of new messages: batchReady.
// A small, bounded tail of already-processed messages is included as
// background so a short batch isn't judged with zero surrounding context
// (e.g. a one-word reply in an ongoing thread whose prior messages already
// settled).

function formatEntryForPrompt({ entry, botId }) {
  return {
    id: entry.id,
    senderName: entry.senderName ?? null,
    // Whether this entry is a message YOU (the agent) previously sent in
    // this thread — the model has no other way to recognize its own prior
    // messages, and a reply following one of them is normally a clear
    // address even without an explicit mention (see prompt text below).
    fromAgent: Boolean(botId) && entry.senderId === botId,
    content: entry.content ?? '',
    botIsMentioned: Boolean(entry.botIsMentioned),
    datetime: entry.datetime ?? null,
  };
}

function formatMemberEntry(member) {
  return { id: member.id, name: member.name };
}

function buildTaggingInstruction({
  spaceId,
  threadKey,
  pendingSlice,
  recentProcessed,
  botId,
  members,
}) {
  if (!spaceId) throw new Error('spaceId is required');
  if (!threadKey) throw new Error('threadKey is required');

  const batch = (Array.isArray(pendingSlice) ? pendingSlice : []).map((entry) =>
    formatEntryForPrompt({ entry, botId })
  );
  const currentMessage = batch.length > 0 ? batch[batch.length - 1] : null;
  const background = (
    Array.isArray(recentProcessed) ? recentProcessed : []
  ).map((entry) => formatEntryForPrompt({ entry, botId }));
  // Real space members only — this is "who could a name in the batch
  // actually refer to," not extract/write_task's assignee list, so the
  // synthetic 'agent' sentinel (config/members.js's AGENT_ASSIGNEE) is
  // deliberately left out here.
  const spaceMembers = (Array.isArray(members) ? members : [])
    .filter((member) => member.id !== 'agent')
    .map(formatMemberEntry);

  return `
## Task

You are the gate this thread's messages pass through. One tool call, \`submit_gate_decision\`, does two separate things — keep them separate in your head:
1. Tag the current message with what it means for you specifically.
2. Decide whether the batch of new messages is ready to hand to the rest of the pipeline.

You are NOT the assistant responding to anyone. Do not answer any question. Do not address any sender. The only text you ever produce is the single acknowledgement word described at the end, after the tool call succeeds.

### 1. Tag the current message

Judge the current message below, read in the context of the rest of the thread.

- \`isAddressed\`: true if the current message is semantically addressed to you — even if no deterministic @mention is present. This is separate from the deterministic mention flag already carried on each message (\`botIsMentioned\`); you are judging intent, not syntax. \`fromAgent: true\` marks a message YOU previously sent in this thread — if the current message directly replies to or follows up on one of those (e.g. answering a question you just asked, or continuing a conversation you're actively part of), that is normally a clear address to you even without an explicit mention. Before deciding, check whether the message actually names or clearly speaks to someone: if that person matches an entry in the space members list below, the message is addressed to them, not to you. You appear nowhere on that list — you have no name of your own in this transcript, and \`fromAgent: true\` is the only signal that a message is from you.
- \`configRequest\`: true if the current message is asking to view, change, or update this space's configuration.

### 2. Decide whether the batch is ready

Judge the whole batch of new messages below, together.

- \`batchReady\`: default to true. Only hold off (false) when the batch is clearly still in progress — an obvious sentence fragment, a lone reaction with nothing to go on, or a first message that plainly sets up a second one still to come (e.g. "so, about the search page..."). If there's already something concrete and actionable in the batch, that's enough — it doesn't need to be the full picture, and it doesn't need to be phrased as a finished thought. Don't wait for a topic to fully wrap up just because more might follow later; a later message can always add to or correct what's already been captured. This also covers a genuinely urgent, need-for-help signal even when the specific ask isn't fully articulated yet (e.g. "we're blocked on this," "this needs to happen today," a clear cry for help) — err toward capturing it now rather than waiting for it to be stated more precisely.
- \`reason\`: one short sentence explaining the \`batchReady\` judgment.

### How to submit

Call \`submit_gate_decision\` exactly once with:
- \`spaceId\`: \`${spaceId}\`, copied verbatim.
- \`threadKey\`: \`${threadKey}\`, copied verbatim.
- \`isAddressed\`, \`configRequest\`, \`batchReady\`: booleans.
- \`reason\`: a short string (explaining the \`batchReady\` judgment).

If it returns \`{ ok: false }\`, fix the parameters and try again. Stop as soon as you receive \`{ ok: true }\`. Do not attempt more than 3 calls total. Do not call any tool other than \`submit_gate_decision\`.

Once it returns \`{ ok: true }\`, respond with exactly the word \`done\` and nothing else — no explanation, no punctuation.

---

### Space members

The real people in this space. Use this to tell a named recipient apart from you.

\`\`\`json
${JSON.stringify(spaceMembers, null, 2)}
\`\`\`

${
  background.length > 0
    ? `
### Recent history

These are already processed, don't re-judge them. They serve as context of previous conversation in this thread to make sense of the new messages.

\`\`\`json
${JSON.stringify(background, null, 2)}
\`\`\`
`
    : ''
}

### New messages

The batch of new messages in this thread, in arrival order, ending with the current message. This is what \`batchReady\` judges.

\`\`\`json
${JSON.stringify(batch, null, 2)}
\`\`\`

### Current new message

The most recent message — the same one that ends the New messages list above. This is what \`isAddressed\` and \`configRequest\` judge.

\`\`\`json
${JSON.stringify(currentMessage, null, 2)}
\`\`\`
`.trim();
}

module.exports = {
  buildTaggingInstruction,
};
