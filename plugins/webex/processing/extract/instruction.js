// ********* PROCESSING/EXTRACT/INSTRUCTION.JS *********
'use strict';

// v3 §7c task extraction — phase 6's new second step, sibling to respond
// (not chained — see plan: Wiring). Communication-only was respond's
// deliberate phase-5 scope; this step is the extraction-only counterpart:
// no message tool (disableMessageTool: true, see extract.js), only
// write_task. Same window shape as respond
// (see format-window.js) plus the active-tasks set, since extract needs it
// to decide new-task vs. update-existing vs. child-of-existing — the same
// context respond gets, used for a different purpose.

const {
  formatWindowSections,
  formatMemberEntry,
  formatTaskEntry,
} = require('../format-window');

function buildExtractInstruction({
  spaceId,
  window,
  messageIds,
  activeTasks,
  members,
  botId,
}) {
  if (!spaceId) throw new Error('spaceId is required');

  const sections = formatWindowSections({ window, messageIds, botId });
  const memberList = Array.isArray(members) ? members : [];
  const tasks = (Array.isArray(activeTasks) ? activeTasks : []).map((task) =>
    formatTaskEntry(task, memberList)
  );
  const spaceMembers = memberList.map(formatMemberEntry);

  return `
## Task

You are maintaining and updating an accurate collection of task items from a batch of new messages in a software engineering team's chat space, supported with additional context.

Read the batch of new messages, and supporting context: recent message history and the collection of active tasks below. Determine:

1. Existing task(s), if any, that should be updated.
2. New task(s), if any, that should be created.

Call \`write_task\` to record your decision per task, however many that is, including none. When your calls are done, reply with exactly the word \`done\` and nothing else.

**Note:** a task is a concrete project-related unit of work of exactly one of the following types:
- **development** — code or a running system: a feature, a bug fix, an integration, a deployment.
- **design** — a design artifact: a UI mockup, an architecture diagram, an API shape, a written spec.
- **research** — a concrete open question investigated to a finding.

## Facts

- spaceId: \`${spaceId}\` — pass this exact value on every call.
- \`fromAgent: true\` signals a message is your own; you have no name in this data.
- All data besides the new messages is already processed, included as context.
- Messages are shown in arrival order.

## Context

### Recent message history

\`\`\`json
${JSON.stringify(sections.history, null, 2)}
\`\`\`

### Batch of new messages

\`\`\`json
${JSON.stringify(sections.batch, null, 2)}
\`\`\`

### Active tasks

\`\`\`json
${JSON.stringify(tasks, null, 2)}
\`\`\`

### Chat space members

\`\`\`json
${JSON.stringify(spaceMembers, null, 2)}
\`\`\`

### Rules

- The \`write_task\` schema defines what each field means and when to set it.
- Evidence comes from the new messages; history, active tasks, and your own messages (\`fromAgent: true\`) are context only.
- Prefer updating an existing task to creating one that overlaps it.
- An update should leave the task accurate in every field the thread has since clarified, not only the one that changed.
- One batch can carry several unrelated points, and a later message does not retire an earlier one.
- Do not invent an assignee — the sender of a message is not automatically doing the work.
- Do not record casual chatter, vague interest, or weak speculation.
- Leave unset anything the thread does not actually establish.
`.trim();
}

module.exports = {
  buildExtractInstruction,
};
