// ********* PROCESSING/RESPOND-INSTRUCTION.JS *********
'use strict';

// v3 phase 5 respond step. Unlike the tagging gate (narrow: pending slice
// only), this step gets the full thread window — it needs enough context to
// actually decide what, if anything, to say.

function formatWindowEntry(entry) {
  return {
    id: entry.id,
    senderName: entry.senderName ?? null,
    content: entry.content ?? '',
    botIsMentioned: Boolean(entry.botIsMentioned),
    datetime: entry.datetime ?? null,
    status: entry.status,
  };
}

function buildRespondInstruction({ spaceId, threadKey, window, directive }) {
  if (!spaceId) throw new Error('spaceId is required');
  if (!threadKey) throw new Error('threadKey is required');

  const pending = Array.isArray(window?.pending) ? window.pending : [];
  const processed = Array.isArray(window?.processed) ? window.processed : [];
  const combined = [...processed, ...pending].map(formatWindowEntry);

  return `
## Task

You are the agent's response step for one Webex thread. You have the thread's recent activity below and one directive explaining why you were triggered. Decide whether a response is warranted, and if so, send it using the available message tool. If not, do not call the message tool at all.

### Directive

- addressed: ${Boolean(directive?.addressed)} — the thread is being directly addressed to you (semantic addressing, judged by a prior classification step — not just a raw @-mention)
- ready: ${Boolean(directive?.ready)} — the pending portion of this thread has crystallized into a complete, coherent unit of meaning
- reason: ${directive?.reason ?? 'n/a'}

If \`addressed\` is true, a response is very likely expected. If only \`ready\` is true (not addressed), respond only if a reply is genuinely warranted — staying silent is the common case for a thread that wasn't talking to you.

### Thread window

Already-processed history followed by the newly-flushed pending portion that triggered this run, in arrival order.

\`\`\`json
${JSON.stringify(combined, null, 2)}
\`\`\`

### How to respond

This conversation is happening in ${
    threadKey === '__main__'
      ? 'the main space (not an existing threaded reply)'
      : `a threaded reply (thread root message id: ${threadKey})`
  }. If you decide to reply, use the message tool — where it lands is handled automatically, not something you need to specify. Keep it natural — you're a participant in this Webex space, not a system announcing an action.

If you decide not to reply, don't call the message tool at all. Once you've made your decision (and sent a message if warranted), respond with exactly the word \`done\` and nothing else — no explanation, no punctuation.
`.trim();
}

module.exports = {
  buildRespondInstruction,
};
