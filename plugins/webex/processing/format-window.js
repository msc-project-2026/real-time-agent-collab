// ********* PROCESSING/FORMAT-WINDOW.JS *********
'use strict';

// Shared prompt-formatting helpers for gate/extract/respond/summarize — one
// builder per concept the model sees, so every step renders it identically
// by construction rather than by four independently-maintained copies
// happening to agree.
//
// Message window: settled history (`processed`, unfiltered — legitimate
// background regardless of which flow produced it) and this run's own batch,
// filtered out of `processing` by the caller's own `messageIds`.
//
// The filter matters because `processing` isn't exclusive to one flow:
// layer 2a (flow/run-message-flow.js) only serializes gate+flush per
// thread, so a second message's flow can have its own batch sitting in
// `processing` at the same time this flow's extract/respond are still
// running. Showing the raw array risks leaking a sibling flow's messages
// into this run's prompt — messageIds (captured once, at this flow's own
// flush) is the only correct way to know which entries are actually ours.
//
// `pending` is deliberately never surfaced here — it's backlog for whichever
// flow processes it next, not something this run has any business seeing.

// fromAgent (whether this entry is a message the bot itself sent) is the
// only reliable signal of the bot's own identity anywhere in this data —
// every step is told the bot has no name of its own, so senderName is
// deliberately nulled out for the bot's own entries rather than showing a
// raw value (an email/id) that would otherwise sit there asking to be
// pattern-matched against instead of using fromAgent.
function formatWindowEntry(entry, botId) {
  const fromAgent = Boolean(botId) && entry.senderId === botId;
  return {
    id: entry.id,
    senderName: fromAgent ? null : entry.senderName ?? null,
    fromAgent,
    botIsMentioned: Boolean(entry.botIsMentioned),
    datetime: entry.datetime ?? null,
    text: entry.content ?? '',
  };
}

function formatWindowSections({ window, messageIds, botId }) {
  if (!Array.isArray(messageIds))
    throw new Error('messageIds array is required');

  const claimed = new Set(messageIds);
  const processingPool = Array.isArray(window?.processing)
    ? window.processing
    : [];

  return {
    history: (Array.isArray(window?.processed) ? window.processed : []).map(
      (entry) => formatWindowEntry(entry, botId)
    ),
    batch: processingPool
      .filter((entry) => claimed.has(entry.id))
      .map((entry) => formatWindowEntry(entry, botId)),
  };
}

// Space members: {id, name} only — email is a storage/board concern, never
// shown to the model. Same shape everywhere a member list appears.
function formatMemberEntry(member) {
  return { id: member.id, name: member.name };
}

// Resolves a task's stored `assigned` value (a stable member id, per
// write_task's own instructions) to that member's current name for display
// — same resolve-by-id, fall-back-to-raw-value logic as the board's own
// resolveAssigneeName (board/src/model.js), so a human and the model land on
// the same answer. Falls back to the raw value untouched for the 'agent'/
// 'unknown' sentinels and any free-text name (someone not a real member) —
// there's nothing to resolve in those cases, not a failure.
function resolveAssigneeDisplay(assigned, members) {
  if (!assigned) return assigned;
  const match = (Array.isArray(members) ? members : []).find(
    (member) => member.id === assigned
  );
  return match?.name ?? assigned;
}

// Active tasks: one shared field set for every step that shows a task list,
// so extract and respond can't quietly drift into showing different facts
// about the "same" task.
function formatTaskEntry(task, members) {
  return {
    id: task.id,
    title: task.title,
    description: task.description,
    type: task.type,
    status: task.status,
    assigned: resolveAssigneeDisplay(task.assigned, members),
    deadline: task.deadline,
    child_tasks: task.child_tasks,
  };
}

module.exports = {
  formatWindowEntry,
  formatWindowSections,
  formatMemberEntry,
  resolveAssigneeDisplay,
  formatTaskEntry,
};
