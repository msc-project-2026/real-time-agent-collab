// ********* PROCESSING/GATE/INSTRUCTION.JS *********
'use strict';

// v3 §4 tagging gate prompt. Context is deliberately narrow: the pending
// slice is the thing being judged. A small, bounded tail of already-processed
// messages is also included as background only (see recentProcessed below) —
// this is not a re-opening of full-window access, just a fix for a short/
// empty pending slice otherwise leaving the gate with zero surrounding
// context (e.g. a one-word reply in an ongoing thread).

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

function buildTaggingInstruction({
  spaceId,
  threadKey,
  pendingSlice,
  recentProcessed,
  botId,
}) {
  if (!spaceId) throw new Error('spaceId is required');
  if (!threadKey) throw new Error('threadKey is required');

  const slice = (Array.isArray(pendingSlice) ? pendingSlice : []).map((entry) =>
    formatEntryForPrompt({ entry, botId })
  );
  const background = (Array.isArray(recentProcessed) ? recentProcessed : []).map(
    (entry) => formatEntryForPrompt({ entry, botId })
  );

  return `
## Task

You are a tagging gate. Your only job is to classify the pending slice of one thread and record the classification by calling the \`tag_message\` tool.

You are NOT the assistant responding to this message. Do not answer any question in it. Do not address the sender. Do not explain your reasoning in prose. The only text you ever produce is the single acknowledgement word described below, after the tool call succeeds.

### What to classify

- \`isAddressed\`: true if the pending slice, read as a whole, is semantically addressed to the bot — even if no deterministic @mention is present. This is separate from the deterministic mention flag already carried on each message; you are judging intent, not syntax. Entries with \`fromAgent: true\` below are messages the bot itself previously sent in this thread — if the next message directly replies to or follows up on one of those (e.g. answering a question the bot just asked, or continuing a conversation the bot is actively part of), that is normally a clear address to the bot even without an explicit mention.
- \`configRequest\`: true if the pending slice is asking to view or change this space's configuration. Fall back to obvious slash-command syntax where applicable.
- \`ready\`: true if the pending slice already contains a complete, coherent unit of meaning worth acting on — not necessarily the whole conversation, just enough that it wouldn't be premature to act on it now.
- \`reason\`: one short sentence explaining the \`ready\` judgment.

### How to call tag_message

Call the \`tag_message\` tool exactly once with:
- \`spaceId\`: \`${spaceId}\`, copied verbatim.
- \`threadKey\`: \`${threadKey}\`, copied verbatim.
- \`isAddressed\`, \`configRequest\`, \`ready\`: booleans.
- \`reason\`: a short string.

If it returns \`{ ok: false }\`, fix the parameters and try again. Stop as soon as you receive \`{ ok: true }\`. Do not attempt more than 3 calls total. Do not call any tool other than \`tag_message\`.

Once it returns \`{ ok: true }\`, respond with exactly the word \`done\` and nothing else — no explanation, no punctuation.
${
  background.length > 0
    ? `
## Recent background (already handled — for context only, do not re-judge)

Up to the last ${background.length} already-processed messages in this thread, included only so a short pending slice isn't judged with zero surrounding context.

\`\`\`json
${JSON.stringify(background, null, 2)}
\`\`\`
`
    : ''
}
## Pending slice

This is the full pending (unprocessed) slice of this thread, in arrival order, ending with the current message. This is what you are classifying.

\`\`\`json
${JSON.stringify(slice, null, 2)}
\`\`\`
`.trim();
}

module.exports = {
  buildTaggingInstruction,
};
