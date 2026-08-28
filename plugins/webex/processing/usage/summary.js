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
    // Computed here as input + output + cacheRead + cacheWrite. Deliberately
    // NOT the provider's own `total` — see providerReportedTotal below.
    total: 0,
    // The provider-reported `total`, summed, kept only for comparison.
    // Do not use it for cost: the embedded-agent runtime accumulates
    // input/output across every model call in a turn but then overwrites
    // `total` with the *last call's* total
    // (`if (usage && lastTurnTotal > 0) usage.total = lastTurnTotal`), so on
    // any multi-call turn it is far too low. Confirmed live on the first
    // smoke run: a two-call gate turn reported input 37453 / total 18847.
    providerReportedTotal: 0,
    durationMs: 0,
  };
}

const SUMMED_KEYS = ['input', 'output', 'cacheRead', 'cacheWrite', 'reasoningTokens'];
// The buckets a provider actually bills for; reasoning tokens are already
// counted inside output.
const BILLED_KEYS = ['input', 'output', 'cacheRead', 'cacheWrite'];

function addInto(target, usage, durationMs) {
  target.calls += 1;
  for (const key of SUMMED_KEYS) {
    const v = usage?.[key];
    if (typeof v === 'number' && Number.isFinite(v)) target[key] += v;
  }
  for (const key of BILLED_KEYS) {
    const v = usage?.[key];
    if (typeof v === 'number' && Number.isFinite(v)) target.total += v;
  }
  const reported = usage?.total;
  if (typeof reported === 'number' && Number.isFinite(reported)) {
    target.providerReportedTotal += reported;
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
