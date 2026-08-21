// ********* TAGGING/INSTRUCTION.JS *********
'use strict';

// v3 §4 tagging gate prompt. Context is deliberately narrow: the thread's
// `pending` slice only (which already includes the current message per §3),
// never the full processed window.

function formatPendingSliceForPrompt({ pendingSlice }) {
  return pendingSlice.map((entry) => ({
    id: entry.id,
    senderName: entry.senderName ?? null,
    content: entry.content ?? '',
    botIsMentioned: Boolean(entry.botIsMentioned),
    datetime: entry.datetime ?? null,
  }));
}

function buildTaggingInstruction({ spaceId, threadKey, pendingSlice }) {
  if (!spaceId) throw new Error('spaceId is required');
  if (!threadKey) throw new Error('threadKey is required');

  const slice = formatPendingSliceForPrompt({
    pendingSlice: Array.isArray(pendingSlice) ? pendingSlice : [],
  });

  return `
## Task

You are a tagging gate. Your only job is to classify the pending slice of one thread and record the classification by calling the \`tag_message\` tool.

You are NOT the assistant responding to this message. Do not answer any question in it. Do not address the sender. Do not explain your reasoning in prose. Do not produce any text output.

### What to classify

- \`isMentioned\`: true if the pending slice, read as a whole, is semantically addressed to the bot — even if no deterministic @mention is present. This is separate from the deterministic mention flag already carried on each message; you are judging intent, not syntax.
- \`configRequest\`: true if the pending slice is asking to view or change this space's configuration. Fall back to obvious slash-command syntax where applicable.
- \`ready\`: true if the pending slice already contains a complete, coherent unit of meaning worth acting on — not necessarily the whole conversation, just enough that it wouldn't be premature to act on it now.
- \`reason\`: one short sentence explaining the \`ready\` judgment.

### How to call tag_message

Call the \`tag_message\` tool exactly once with:
- \`spaceId\`: \`${spaceId}\`, copied verbatim.
- \`threadKey\`: \`${threadKey}\`, copied verbatim.
- \`isMentioned\`, \`configRequest\`, \`ready\`: booleans.
- \`reason\`: a short string.

If it returns \`{ ok: false }\`, fix the parameters and try again. Stop as soon as you receive \`{ ok: true }\`. Do not attempt more than 3 calls total. Do not call any tool other than \`tag_message\`. Do not produce any text output.

## Pending slice

This is the full pending (unprocessed) slice of this thread, in arrival order, ending with the current message.

\`\`\`json
${JSON.stringify(slice, null, 2)}
\`\`\`
`.trim();
}

module.exports = {
  buildTaggingInstruction,
};
