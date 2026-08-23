// ********* PROCESSING/FORMAT-WINDOW.JS *********
'use strict';

// Shared by respond-instruction.js and extract-instruction.js — both need
// the same two-part rendering of a thread window (storage/threads-store.js):
// settled history (`processed`, unfiltered — legitimate background
// regardless of which flow produced it) and this run's own batch, filtered
// out of `processing` by the caller's own `messageIds`.
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

function formatWindowEntry(entry) {
  return {
    id: entry.id,
    senderName: entry.senderName ?? null,
    content: entry.content ?? '',
    botIsMentioned: Boolean(entry.botIsMentioned),
    datetime: entry.datetime ?? null,
  };
}

function formatWindowSections({ window, messageIds }) {
  if (!Array.isArray(messageIds)) throw new Error('messageIds array is required');

  const claimed = new Set(messageIds);
  const processingPool = Array.isArray(window?.processing) ? window.processing : [];

  return {
    history: (Array.isArray(window?.processed) ? window.processed : []).map(
      formatWindowEntry
    ),
    batch: processingPool.filter((entry) => claimed.has(entry.id)).map(formatWindowEntry),
  };
}

module.exports = {
  formatWindowEntry,
  formatWindowSections,
};
