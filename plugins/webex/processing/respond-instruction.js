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
  };
}

function buildRespondInstruction({ spaceId, threadKey, window, directive, replyThreadId }) {
  if (!spaceId) throw new Error('spaceId is required');
  if (!threadKey) throw new Error('threadKey is required');

  const pending = Array.isArray(window?.pending) ? window.pending : [];
  const processed = Array.isArray(window?.processed) ? window.processed : [];
  const combined = [...processed, ...pending].map(formatWindowEntry);

  return `
## Task

You are the agent's response step for one Webex thread. You have the thread's recent activity below and one directive explaining why you were triggered. Decide whether a response is warranted, and if so, send it using the available message tool. If not, do not call the message tool at all.

You are not limited to a single message. The pending portion below may contain more than one distinct point worth addressing — if so, call the message tool as many times as genuinely warranted, one call per message, the same way a person would send a couple of short messages in a row rather than cramming unrelated replies into one wall of text. Don't call it repeatedly for no reason, though — most turns still warrant exactly one reply, or none.

### Directive

- addressed: ${Boolean(directive?.addressed)} — the thread is being directly addressed to you (semantic addressing, judged by a prior classification step — not just a raw @-mention)
- ready: ${Boolean(directive?.ready)} — the pending portion of this thread has crystallized into a complete, coherent unit of meaning
- reason: ${directive?.reason ?? 'n/a'}

If \`addressed\` is true, you should respond — someone is actively talking to you and expecting a reply, the same as if they'd spoken to you directly in person. Do not withhold a reply just because the message itself doesn't look like a formal question or request — a casual remark aimed at you (e.g. "you there?", "are you free?") still gets a reply, the same way a person would answer rather than stay silent. If only \`ready\` is true (not addressed), respond only if a reply is genuinely warranted — staying silent is the common case for a thread that wasn't talking to you.

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
  }. If you decide to reply, use the message tool and set both its \`threadId\` and \`replyTo\` parameters to \`${replyThreadId}\` so the reply lands in the right place — do not omit them, an untargeted reply lands in the main space regardless of where this conversation is actually happening. Keep it natural — you're a participant in this Webex space, not a system announcing an action.

If you decide not to reply, don't call the message tool at all. Once you've made your decision (and sent whatever messages were warranted, one or more, via however many tool calls that took), respond with exactly the word \`done\` and nothing else — no explanation, no punctuation.
`.trim();
}

module.exports = {
  buildRespondInstruction,
};
