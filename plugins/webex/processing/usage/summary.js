// ********* PROCESSING/USAGE/SUMMARY.JS *********
'use strict';

// Phase 8 — aggregate per-step token usage from job-log records.
//
// Each job-log entry (flow/job-log.js) now carries an optional `usage` field
// shaped by processing/usage/from-result.js:
//   { provider, model, durationMs, contextTokens, usage: {input,output,cacheRead,cacheWrite,reasoningTokens,total}, lastCallUsage }
//
// This module rolls a list of those records up by step and in total. Pure —
// no I/O — so it's equally usable from the eval scorer and from an ad-hoc
// production cost query over a space's job logs.

const STEP_ORDER = ['gate', 'extract', 'summarize', 'respond'];

function emptyBucket() {
  return {
    calls: 0,
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    reasoningTokens: 0,
    total: 0,
    durationMs: 0,
  };
}

function addInto(target, usage, durationMs) {
  target.calls += 1;
  for (const key of ['input', 'output', 'cacheRead', 'cacheWrite', 'reasoningTokens', 'total']) {
    const v = usage?.[key];
    if (typeof v === 'number' && Number.isFinite(v)) target[key] += v;
  }
  if (typeof durationMs === 'number' && Number.isFinite(durationMs)) {
    target.durationMs += durationMs;
  }
}

// records: array of job-log entries (objects with `step` and optional `usage`).
// Returns { byStep: { <step>: bucket }, total: bucket, models: { "<provider>/<model>": bucket } }.
function summarizeUsage(records) {
  const list = Array.isArray(records) ? records : [];
  const byStep = {};
  const models = {};
  const total = emptyBucket();

  for (const record of list) {
    const entry = record?.usage;
    if (!entry || (!entry.usage && !entry.lastCallUsage)) continue;

    const usage = entry.usage ?? entry.lastCallUsage;
    const step = typeof record.step === 'string' ? record.step : 'unknown';

    byStep[step] = byStep[step] ?? emptyBucket();
    addInto(byStep[step], usage, entry.durationMs);
    addInto(total, usage, entry.durationMs);

    const modelKey = `${entry.provider ?? 'unknown'}/${entry.model ?? 'unknown'}`;
    models[modelKey] = models[modelKey] ?? emptyBucket();
    addInto(models[modelKey], usage, entry.durationMs);
  }

  // Stable, readable ordering: known steps first in pipeline order, then any others.
  const orderedByStep = {};
  for (const step of STEP_ORDER) {
    if (byStep[step]) orderedByStep[step] = byStep[step];
  }
  for (const step of Object.keys(byStep)) {
    if (!orderedByStep[step]) orderedByStep[step] = byStep[step];
  }

  return { byStep: orderedByStep, total, models };
}

module.exports = {
  summarizeUsage,
  STEP_ORDER,
};
