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

function formatMemberEntry(member) {
  return { id: member.id, name: member.name };
}

function buildExtractInstruction({ spaceId, window, messageIds, activeTasks, members }) {
  if (!spaceId) throw new Error('spaceId is required');

  const sections = formatWindowSections({ window, messageIds });
  const tasks = (Array.isArray(activeTasks) ? activeTasks : []).map(formatTaskEntry);
  const spaceMembers = (Array.isArray(members) ? members : []).map(formatMemberEntry);

  return `
## Task

You are the agent's extraction step for one Webex thread. Your only job is to identify task-worthy points in the messages below and record them by calling \`write_task\`. You do not reply to anyone and you are not evaluating whether to respond — that is a separate step running independently of this one.

A task-worthy point is a concrete project deliverable, falling into exactly one of these three categories — nothing else qualifies, no matter how important it seems in the conversation:
- **development**: writing, fixing, or shipping code or a running system — a feature, a bug fix, an integration, a deployment.
- **design**: producing a concrete design artifact — a UI mockup, an architecture diagram, an API shape, a written spec.
- **research**: investigating a concrete open question and producing a finding — evaluating an option, prototyping to answer a question, gathering information the team needs.

Anything else is out of scope for \`write_task\`, however notable it is in the thread — a decision being made, a question directed at you seeking information or input, general discussion, status updates, acknowledgements. A request for concrete work is still task-worthy even when it's phrased as a question or addressed to someone other than you — judge by what's actually being asked for, not by the sentence's grammatical mood or who it's aimed at. Not every message contains a task-worthy point — most turns may warrant zero \`write_task\` calls, and that's the expected common case.

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

### Space members

\`\`\`json
${JSON.stringify(spaceMembers, null, 2)}
\`\`\`

### Facts

- spaceId: \`${spaceId}\`

Always pass this exact spaceId to every \`write_task\`/\`search_tasks\` call — copy it verbatim, never guess or reconstruct it.

### Tools available to you

You have exactly two tools for this task: \`write_task\`, to create or update a task, and \`search_tasks\`, to check for an existing task not listed above before creating a duplicate. Use only these.

### How to extract

Check every new message on its own, even ones that arrive back-to-back on the same topic from the same person — a batch can contain more than one task-worthy point, and a later message continuing the thread doesn't retire an earlier one. Don't let an earlier point go uncaptured just because a later message in the same batch covered a related but distinct piece of work.

For each task-worthy point:
- Decide whether it's new or an update to one of the active tasks above (or found via \`search_tasks\`). Pass the existing task's \`id\` to update it; omit \`id\` to create a new one.
- Always include a short \`title\` when creating a task — a few words summarizing what it actually is (e.g. "Fix login test flakiness"), not a restatement of the type. Add \`description\` only if the title alone would leave out something that matters.
- Always include \`message_ids\` — the specific message id(s) that are direct evidence for this task. Never omit this.
- Use \`child_tasks\` when the point is naturally a sub-part of an existing task, rather than creating an unrelated duplicate.
- Set \`assigned\`/\`deadline\` only when the thread actually states them — leave them unset otherwise rather than guessing. When the thread assigns the task to a specific person, set \`assigned\` to their \`id\` from the space members list above, not their name — match by who's speaking/mentioned in the messages you're extracting from. Use \`assigned: "agent"\` when the task is for you yourself to pick up. If the person clearly isn't in the list, fall back to their name as free text rather than inventing an id.
- **Status, human-assigned or unassigned tasks**: free — set \`status\` only if the thread clearly shows real progress already exists (e.g. someone says they already started it, or it's already done); otherwise leave it unset and the default applies. No \`confidence\` needed for these.
- **Status, agent-assigned tasks** (\`assigned: "agent"\`): never set \`status\` yourself. Instead, set \`confidence\` (0-1) — the system decides the outcome deterministically from it, either holding the task for human approval or auto-starting it. Weigh two things: how explicitly you were actually directed to do this, and how well it fits a safe, clearly in-scope pickup (e.g. a small, low-risk contribution that naturally follows from a design conversation can still warrant real confidence even without an explicit instruction — but anything ambiguous or higher-stakes should score low). Rough bands: 0.8+ for an explicit, unambiguous instruction; 0.4-0.7 for a reasonable but not certain pickup; below 0.4 for a speculative or risky one.

Call \`write_task\` once per task-worthy point — as many or as few times as the batch actually warrants, including zero. Once you've made all the calls you need, respond with exactly the word \`done\` and nothing else — no explanation, no punctuation.
`.trim();
}

module.exports = {
  buildExtractInstruction,
};
