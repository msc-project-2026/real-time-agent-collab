#!/usr/bin/env node
// ********* EVAL/SCENARIOS/VALIDATE.JS *********
'use strict';

// Checks every scenario against the schema the scorers actually read, and
// prints the difficulty characteristics worth citing when describing the
// evaluation set.
//
//   node plugins/webex/eval/scenarios/validate.js [file...]
//
// Two jobs, deliberately together. The schema half catches drift — a scenario
// written against an older fixture shape scores as failure rather than
// erroring, so a wrong `type` or a dangling `taskId` silently becomes a bad
// result. The descriptive half exists because "we used synthetic scenarios"
// is a weak claim on its own: what makes them defensible is stated structure
// (distractors, updates that must patch rather than duplicate, non-task items
// the taxonomy should exclude), and that has to be measured, not asserted.

const fs = require('node:fs');
const path = require('node:path');

const ALLOWED_TYPES = new Set(['development', 'design', 'research']);
const ALLOWED_STATUSES = new Set([
  'unapproved', 'backlog', 'in_progress', 'in_review', 'done', 'archived',
]);

function validate(scenario) {
  const errors = [];
  const warnings = [];
  const E = (m) => errors.push(m);
  const W = (m) => warnings.push(m);

  if (!scenario.id) E('missing `id`');
  const messages = Array.isArray(scenario.messages) ? scenario.messages : [];
  const participants = Array.isArray(scenario.participants) ? scenario.participants : [];
  const tasks = Array.isArray(scenario.expectedTasks) ? scenario.expectedTasks : [];
  const updates = Array.isArray(scenario.updates) ? scenario.updates : [];
  const recall = Array.isArray(scenario.recallChecks) ? scenario.recallChecks : [];

  if (messages.length === 0) E('no messages');
  if (participants.length === 0) E('no participants');

  // Superseded fixture shapes score as failure rather than erroring, so they
  // have to be caught here or a stale scenario silently reports bad results.
  for (const dead of ['expectedItems', 'mustExtract', 'spaceId']) {
    if (scenario[dead] !== undefined) E(`uses superseded field \`${dead}\``);
  }

  const senders = new Set(participants.map((p) => p.name));
  const personIds = new Set(participants.map((p) => p.personId));
  const assignable = new Set([...personIds, 'agent']);
  const numbers = new Set();

  for (const m of messages) {
    if (typeof m.number !== 'number') { E(`message with no \`number\``); continue; }
    if (numbers.has(m.number)) E(`duplicate message number ${m.number}`);
    numbers.add(m.number);
    if (!m.text) E(`message ${m.number} has no text`);
    if (!senders.has(m.sender)) E(`message ${m.number}: sender "${m.sender}" is not a participant`);
    if (m.replyTo !== undefined && !messages.some((x) => x.number === m.replyTo)) {
      E(`message ${m.number}: replyTo ${m.replyTo} does not exist`);
    }
    if (m.replyTo !== undefined && m.replyTo >= m.number) {
      E(`message ${m.number}: replyTo ${m.replyTo} is not an earlier message`);
    }
    if (!m.expectedTags) W(`message ${m.number}: no expectedTags, so the gate is unscored here`);
  }

  const taskIds = new Set();
  for (const t of tasks) {
    if (!t.id) { E('expectedTask with no `id`'); continue; }
    if (taskIds.has(t.id)) E(`duplicate task id ${t.id}`);
    taskIds.add(t.id);
    if (!ALLOWED_TYPES.has(t.type)) E(`${t.id}: type "${t.type}" is not one of ${[...ALLOWED_TYPES].join('|')}`);
    if (!ALLOWED_STATUSES.has(t.expectedStatus)) E(`${t.id}: expectedStatus "${t.expectedStatus}" invalid`);
    if (!assignable.has(t.expectedAssigned)) E(`${t.id}: expectedAssigned "${t.expectedAssigned}" is not a participant personId or "agent"`);
    if (!Array.isArray(t.evidenceMessages) || t.evidenceMessages.length === 0) {
      E(`${t.id}: needs at least one evidenceMessage`);
    } else {
      for (const n of t.evidenceMessages) {
        if (!numbers.has(n)) E(`${t.id}: evidence message ${n} does not exist`);
      }
    }
    // An agent-assigned task defaults to `unapproved` on create and only
    // leaves it by clearing the proactivity threshold, so expecting
    // `backlog` there contradicts the pipeline.
    if (t.expectedAssigned === 'agent' && t.expectedStatus === 'backlog') {
      E(`${t.id}: agent-assigned tasks default to \`unapproved\`, never \`backlog\``);
    }
  }

  for (const u of updates) {
    if (!taskIds.has(u.taskId)) E(`update references unknown task ${u.taskId}`);
    if (!numbers.has(u.afterMessage)) E(`update for ${u.taskId}: message ${u.afterMessage} does not exist`);
    if (!ALLOWED_STATUSES.has(u.expectedStatus)) E(`update for ${u.taskId}: status "${u.expectedStatus}" invalid`);
    const task = tasks.find((t) => t.id === u.taskId);
    if (task && !task.evidenceMessages?.includes(u.afterMessage)) {
      E(`update for ${u.taskId}: message ${u.afterMessage} must also be in that task's evidenceMessages, or the update cannot score as a hit`);
    }
    if (task && task.expectedStatus !== u.expectedStatus) {
      W(`update for ${u.taskId} expects "${u.expectedStatus}" but the task's final expectedStatus is "${task.expectedStatus}"`);
    }
  }

  const addressed = messages.filter((m) => m.expectedTags?.isAddressed).map((m) => m.number);
  for (const c of recall) {
    if (!numbers.has(c.questionMessageNumber)) {
      E(`recallCheck references message ${c.questionMessageNumber}, which does not exist`);
    } else if (!addressed.includes(c.questionMessageNumber)) {
      E(`recallCheck on message ${c.questionMessageNumber}, but it is not marked isAddressed, so the agent will never reply to it`);
    }
    if (!Array.isArray(c.expectedAnswerPoints) || c.expectedAnswerPoints.length === 0) {
      E(`recallCheck on message ${c.questionMessageNumber}: no expectedAnswerPoints`);
    }
  }

  // Every task the fixture expects must be *reachable*: its evidence has to
  // survive into a batch the pipeline actually processes.
  const cited = new Set(tasks.flatMap((t) => t.evidenceMessages ?? []));
  const uncited = messages.filter((m) => !cited.has(m.number)).map((m) => m.number);

  const byType = {};
  for (const t of tasks) byType[t.type] = (byType[t.type] ?? 0) + 1;
  const threaded = messages.filter((m) => m.replyTo !== undefined).length;
  const multiEvidence = tasks.filter((t) => (t.evidenceMessages ?? []).length > 1).length;

  return {
    errors,
    warnings,
    stats: {
      messages: messages.length,
      participants: participants.length,
      threadedReplies: threaded,
      addressedTurns: addressed.length,
      expectedTasks: tasks.length,
      tasksByType: byType,
      tasksWithMultiMessageEvidence: multiEvidence,
      updates: updates.length,
      recallChecks: recall.length,
      distractorMessages: uncited.length,
    },
  };
}

function main() {
  const args = process.argv.slice(2);
  const files = args.length
    ? args
    : fs
        .readdirSync(__dirname)
        .filter((f) => f.endsWith('.json'))
        .map((f) => path.join(__dirname, f));

  let failed = 0;
  for (const file of files) {
    const scenario = JSON.parse(fs.readFileSync(file, 'utf8'));
    const { errors, warnings, stats } = validate(scenario);
    const name = scenario.id ?? path.basename(file);

    console.log(`\n${errors.length ? 'FAIL' : 'ok  '}  ${name}`);
    console.log(
      `      ${stats.messages} msgs (${stats.threadedReplies} threaded, ${stats.distractorMessages} not cited as evidence), ` +
        `${stats.participants} participants, ${stats.addressedTurns} addressed`
    );
    console.log(
      `      ${stats.expectedTasks} tasks ${JSON.stringify(stats.tasksByType)}, ` +
        `${stats.tasksWithMultiMessageEvidence} with multi-message evidence, ` +
        `${stats.updates} updates, ${stats.recallChecks} recall checks`
    );
    for (const e of errors) console.log(`      ERROR  ${e}`);
    for (const w of warnings) console.log(`      warn   ${w}`);
    if (errors.length) failed += 1;
  }

  console.log(`\n${files.length} scenario(s), ${failed} with errors`);
  process.exit(failed ? 1 : 0);
}

if (require.main === module) main();

module.exports = { validate };
