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
const path = require('node:path');

const { jobsDir, jobLogPath } = require('../storage/paths');

async function appendJobLogEntry({
  spaceId,
  flowId,
  step,
  runId,
  sessionKey,
  sessionId,
  startedAt,
  endedAt,
  outcome,
  error,
  toolCalls,
  usage,
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
    // Unique per spawn — the join key for phase-8 usage records
    // (processing/usage/store.js), which key `model.usage` events by the same
    // sessionId the dispatch passed to runEmbeddedAgent.
    sessionId: sessionId ?? null,
    startedAt: startedAt ?? null,
    endedAt: endedAt ?? null,
    outcome: outcome ?? null,
    error: error ?? null,
    toolCalls: toolCalls ?? null,
    // Per-turn token accounting for this step's embedded-agent spawn, read
    // straight off the runEmbeddedAgent return value
    // (processing/usage/from-result.js). null for deterministic steps
    // (task-notify) and for spawns that never reached a model call.
    // processing/usage/summary.js aggregates these across a space's job logs.
    usage: usage ?? null,
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

// Reads every per-flow job-log file for a space and returns one flat,
// chronologically-sorted array of step records. Used by the phase-8 eval
// runner (to bundle a scenario's step-level trace + token usage) and by any
// ad-hoc per-space cost query via processing/usage/summary.js. Missing dir →
// empty array; a partially-written trailing line is skipped, not fatal.
async function readJobLogEntries({ spaceId, explicitRoot } = {}) {
  if (!spaceId) throw new Error('spaceId is required');

  const dir = jobsDir(spaceId, explicitRoot);
  let files;
  try {
    files = await fs.readdir(dir);
  } catch (err) {
    if (err?.code === 'ENOENT') return [];
    throw err;
  }

  const records = [];
  for (const file of files) {
    if (!file.endsWith('.jsonl')) continue;
    const raw = await fs.readFile(path.join(dir, file), 'utf8');
    for (const line of raw.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        records.push(JSON.parse(trimmed));
      } catch {
        // Partial trailing write from a crash mid-append — ignore.
      }
    }
  }

  records.sort((a, b) => String(a.at ?? '').localeCompare(String(b.at ?? '')));
  return records;
}

module.exports = {
  appendJobLogEntry,
  readJobLogEntries,
};
