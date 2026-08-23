// ********* PROCESSING/EXTRACT/INSTRUCTION.JS *********
'use strict';

// v3 §7c task extraction — phase 6's new second step, sibling to respond
// (not chained — see plan: Wiring). Communication-only was respond's
// deliberate phase-5 scope; this step is the extraction-only counterpart:
// no message tool (disableMessageTool: true, see extract.js), only
// write_task and search_tasks. Same window shape as respond
// (see format-window.js) plus the active-tasks set, since extract needs it
// to decide new-task vs. update-existing vs. child-of-existing — the same
// context respond gets, used for a different purpose.

const { formatWindowSections } = require('../format-window');

function formatTaskEntry(task) {
  return {
    id: task.id,
    title: task.title,
    description: task.description,
    type: task.type,
    status: task.status,
    assigned: task.assigned,
    deadline: task.deadline,
    child_tasks: task.child_tasks,
  };
}

function buildExtractInstruction({ spaceId, window, messageIds, activeTasks }) {
  if (!spaceId) throw new Error('spaceId is required');

  const sections = formatWindowSections({ window, messageIds });
  const tasks = (Array.isArray(activeTasks) ? activeTasks : []).map(formatTaskEntry);

  return `
## Task

You are the agent's extraction step for one Webex thread. Your only job is to identify task-worthy points in the messages below and record them by calling \`write_task\`. You do not reply to anyone and you are not evaluating whether to respond — that is a separate step running independently of this one.

A task-worthy point is concrete work: something to build, decide on, research, or coordinate that a person or the team should track and follow up on. Not every message contains one — most turns may warrant zero \`write_task\` calls, and that's the expected common case. Casual remarks, acknowledgements, and pure conversation are not tasks.

### Recent history

For context only — do not extract from this.

\`\`\`json
${JSON.stringify(sections.history, null, 2)}
\`\`\`

### New messages

This is what you're extracting from.

\`\`\`json
${JSON.stringify(sections.batch, null, 2)}
\`\`\`

### Active tasks

Tasks already tracked for this space. Before creating a new task, check whether the point you found is actually an update to one of these (new evidence, a status change, a natural sub-task) rather than a duplicate.

\`\`\`json
${JSON.stringify(tasks, null, 2)}
\`\`\`

### Tools available to you

You have exactly two tools for this task: \`write_task\`, to create or update a task, and \`search_tasks\`, to check for an existing task not listed above before creating a duplicate. Use only these.

### How to extract

For each task-worthy point:
- Decide whether it's new or an update to one of the active tasks above (or found via \`search_tasks\`). Pass the existing task's \`id\` to update it; omit \`id\` to create a new one.
- Always include a short \`title\` when creating a task — a few words summarizing what it actually is (e.g. "Fix login test flakiness"), not a restatement of the type. Add \`description\` only if the title alone would leave out something that matters.
- Always include \`message_ids\` — the specific message id(s) that are direct evidence for this task. Never omit this.
- Use \`child_tasks\` when the point is naturally a sub-part of an existing task, rather than creating an unrelated duplicate.
- Set \`assigned\`/\`deadline\` only when the thread actually states them — leave them unset otherwise rather than guessing.

Call \`write_task\` once per task-worthy point — as many or as few times as the batch actually warrants, including zero. Once you've made all the calls you need, respond with exactly the word \`done\` and nothing else — no explanation, no punctuation.
`.trim();
}

module.exports = {
  buildExtractInstruction,
};
