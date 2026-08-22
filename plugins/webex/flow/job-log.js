// ********* FLOW/JOB-LOG.JS *********
'use strict';

// Step-level audit trail for the phase-5 message flow. Task Flow's own
// task-level tracking (runTask) is not used here — confirmed unreliable for
// runEmbeddedAgent-driven spawns (see v3 migration memory: any task
// registered with runtime:"subagent" from this plugin is eventually marked
// "lost" by a background sweep, since no matching subagent_runs row can ever
// exist). This log is the real per-step record instead: one append per step
// attempt, joinable back to `openclaw tasks flow show <flowId>` by flowId.

const fs = require('node:fs/promises');

const { jobsDir, jobLogPath } = require('../storage/paths');

async function appendJobLogEntry({
  spaceId,
  flowId,
  step,
  runId,
  sessionKey,
  startedAt,
  endedAt,
  outcome,
  error,
  toolCalls,
  inputSummary,
  explicitRoot,
}) {
  if (!spaceId) throw new Error('spaceId is required');
  if (!flowId) throw new Error('flowId is required');
  if (!step) throw new Error('step is required');

  const record = {
    at: new Date().toISOString(),
    flowId,
    step,
    runId: runId ?? null,
    sessionKey: sessionKey ?? null,
    startedAt: startedAt ?? null,
    endedAt: endedAt ?? null,
    outcome: outcome ?? null,
    error: error ?? null,
    toolCalls: toolCalls ?? null,
    inputSummary: inputSummary ?? null,
  };

  await fs.mkdir(jobsDir(spaceId, explicitRoot), { recursive: true });
  await fs.appendFile(
    jobLogPath(spaceId, flowId, explicitRoot),
    `${JSON.stringify(record)}\n`,
    'utf8'
  );

  return record;
}

module.exports = {
  appendJobLogEntry,
};
