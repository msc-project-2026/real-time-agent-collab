// ********* PROCESSING/RESPOND/INSTRUCTION.JS *********
'use strict';

// v3 phase 5 respond step. Unlike the tagging gate (narrow: pending slice
// only), this step gets the full thread window — it needs enough context to
// actually decide what, if anything, to say. Phase 6 adds the active-tasks
// injection (so a reply can reference a task from a prior turn's extraction)
// and the search_tasks tool for anything outside that set — task *writing*
// stays extract's job; respond never gets write_task (see phase-6 plan:
// Concurrency / tool visibility — no per-step tool allowlist exists, so the
// only lever here is telling the model exactly which tools are its job,
// the same pattern tag_message's own description already relies on).
// Phase 7 adds search_recall (v3 §9) for on-demand recall of something from
// earlier history — possibly a different thread — that isn't already in
// the window above.

const { formatWindowSections } = require('../format-window');

function formatTaskEntry(task) {
  return {
    id: task.id,
    title: task.title,
    type: task.type,
    status: task.status,
    assigned: task.assigned,
    deadline: task.deadline,
  };
}

function formatKnownFacts(knownFacts) {
  const lines = [`- This Webex space's id: \`${knownFacts?.spaceId ?? 'unknown'}\``];
  if (knownFacts?.boardUrl) {
    lines.push(`- Task board URL for this space: ${knownFacts.boardUrl}`);
  }
  if (Array.isArray(knownFacts?.members) && knownFacts.members.length > 0) {
    const memberList = knownFacts.members
      .map((member) => `${member.name} (id: \`${member.id}\`)`)
      .join(', ');
    lines.push(`- Members of this space: ${memberList}`);
  }
  return lines.join('\n');
}

function buildRespondInstruction({
  spaceId,
  threadKey,
  window,
  messageIds,
  directive,
  replyThreadId,
  activeTasks,
  knownFacts,
}) {
  if (!spaceId) throw new Error('spaceId is required');
  if (!threadKey) throw new Error('threadKey is required');

  const sections = formatWindowSections({ window, messageIds });
  const tasks = (Array.isArray(activeTasks) ? activeTasks : []).map(formatTaskEntry);

  return `
## Task

You are the agent's response step for one Webex thread. You are only ever invoked because the thread was determined to be addressed to you — someone is actively talking to you and expecting a reply, the same as if they'd spoken to you directly in person. You have the thread's recent history and the new message(s) below. Decide what, if anything, to say, and send it using the message tool.

The new messages below may include more than one message — but only the *last* one is what actually addressed you; the gate flushes a thread's entire unaddressed backlog together the moment something finally does address it, so earlier entries in that list are background you were never directly spoken to about, not separate points each needing their own reply. Treat them as context for understanding the last message, same as recent history. You're not limited to a single reply, though — if the last message itself raises more than one distinct point, call the message tool as many times as genuinely warranted, one call per point, the same way a person would send a couple of short messages in a row rather than cramming unrelated replies into one wall of text. Don't call it repeatedly for no reason, though — most turns still warrant exactly one reply, or none.

### Directive

- reason: ${directive?.reason ?? 'n/a'}

Do not withhold a reply just because the message itself doesn't look like a formal question or request — a casual remark aimed at you (e.g. "you there?", "are you free?") still gets a reply, the same way a person would answer rather than stay silent.

### Recent history

\`\`\`json
${JSON.stringify(sections.history, null, 2)}
\`\`\`

### New messages

\`\`\`json
${JSON.stringify(sections.batch, null, 2)}
\`\`\`

### Active tasks

Tasks currently tracked for this space, most recently updated first. You may reference one of these by name in your reply if relevant.

\`\`\`json
${JSON.stringify(tasks, null, 2)}
\`\`\`

### Known facts

If asked about any of these, answer directly and exactly — never guess or invent a value for something not listed here.

${formatKnownFacts(knownFacts)}

### Tools available to you

You have exactly three tools for this task: the message tool, to send a reply, \`search_tasks\`, to look up a task that's referenced but isn't listed above, and \`search_recall\`, to look up something from earlier history — possibly a different thread in this space — that isn't already shown above. Use only these.

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
