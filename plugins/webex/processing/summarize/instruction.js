// ********* PROCESSING/SUMMARIZE/INSTRUCTION.JS *********
'use strict';

// v3 §9 recall — phase 7's new step, a parallel sibling to extract (see §7b's
// own recommended sequencing: "pulling summarize out as a parallel sibling to
// extract"). Same window shape as extract/respond (format-window.js), plus
// two distinct context sources, deliberately kept separate:
// - recentSummaries: deterministic, same-thread-only continuity — a cheap
//   background fact, not a search, so a new summary reads as a continuation
//   of this thread's own history rather than being written in a vacuum.
// - search_recall: model-driven, space-wide (not thread-limited — see the
//   §9 doc correction) — for finding a genuine supersession candidate
//   anywhere in the space. There is no deterministic candidate pre-fetch
//   here; that was the original §9 text's design, replaced by giving the
//   model the tool and letting it phrase its own query (avoids the
//   batch-text-vs-summary-text embedding mismatch a mechanical pre-fetch
//   would have hit).

const { formatWindowSections } = require('../format-window');

function formatRecentSummary(entry) {
  return {
    id: entry.id,
    summary_text: entry.summary_text,
    created_at: entry.created_at,
  };
}

function buildSummarizeInstruction({ spaceId, threadKey, window, messageIds, recentSummaries }) {
  if (!spaceId) throw new Error('spaceId is required');
  if (!threadKey) throw new Error('threadKey is required');

  const sections = formatWindowSections({ window, messageIds });
  const recent = (Array.isArray(recentSummaries) ? recentSummaries : []).map(formatRecentSummary);

  return `
## Task

You are the agent's summarization step for one Webex thread. Your only job is to distill the new messages below into one recall entry by calling \`write_summary\`. You do not reply to anyone and you do not extract tasks — those are separate steps running independently of this one.

A good summary is a distilled gist, not a transcript — capture what was actually decided, asked, or established, in your own words. Also pick a few \`keywords\`: exact names, numbers, or specifics that a semantic search over the summary text alone might miss.

### Facts

- spaceId: \`${spaceId}\`
- threadId: \`${threadKey}\`

### Recent history

For context only.

\`\`\`json
${JSON.stringify(sections.history, null, 2)}
\`\`\`

### New messages

This is what you're summarizing.

\`\`\`json
${JSON.stringify(sections.batch, null, 2)}
\`\`\`

### Recent summaries for this thread

For continuity — so your summary reads as a continuation of this thread's own history, not written in a vacuum. Most recent first.

\`\`\`json
${JSON.stringify(recent, null, 2)}
\`\`\`

### Tools available to you

You have exactly two tools for this task: \`search_recall\`, to check whether this batch supersedes an existing summary anywhere in this space (not just this thread), and \`write_summary\`, to record your result. Use only these.

### How to summarize

- Call \`search_recall\` if the batch plausibly updates or replaces something discussed before — it returns full supersession chains, so judge from the timestamps which result is actually current.
- Call \`write_summary\` exactly once for this batch: a distilled \`summaryText\`, a few \`keywords\`, the \`messageIds\` this summary distills, and \`supersedes\` (the id of the current-head entry from \`search_recall\`, if this batch genuinely replaces it — omit otherwise).
- Always pass \`spaceId\` and \`threadId\` exactly as given above.

Once you've called \`write_summary\`, respond with exactly the word \`done\` and nothing else — no explanation, no punctuation.
`.trim();
}

module.exports = {
  buildSummarizeInstruction,
};
