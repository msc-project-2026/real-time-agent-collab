// ********* PROCESSING/USAGE/FROM-RESULT.JS *********
'use strict';

// Phase 8 token-usage observability.
//
// The obvious path — subscribing to `model.usage` diagnostic events from a
// registered plugin service — does NOT work in this gateway version:
// `ctx.internalDiagnostics` is granted only to bundled services named
// `diagnostics-otel` / `diagnostics-prometheus` (confirmed in the deployed
// bundle's `createServiceContext`). A third-party plugin service can never
// see those events.
//
// Instead we read usage straight off what `pluginRuntime.agent.runEmbeddedAgent`
// already returns. Its `meta.agentMeta.usage` is a per-turn accumulator summed
// across every model call the embedded turn made (tool loops included), and it
// is populated on both the success and error return paths. That's exactly one
// usage figure per pipeline step spawn, with zero extra plumbing.
//
// Shape (from `embedded-agent-BJoLKBHa.js`, gateway 2026.7.1):
//   result.meta.durationMs
//   result.meta.agentMeta = {
//     provider, model, contextTokens, promptTokens,
//     usage:        { input, output, cacheRead, cacheWrite, reasoningTokens, total },
//     lastCallUsage:{ ...same shape, last call only },
//   }
// All fields are read defensively — a shape drift yields null, never a throw.

function asFiniteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function normalizeUsageBuckets(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const buckets = {
    input: asFiniteNumber(raw.input),
    output: asFiniteNumber(raw.output),
    cacheRead: asFiniteNumber(raw.cacheRead),
    cacheWrite: asFiniteNumber(raw.cacheWrite),
    reasoningTokens: asFiniteNumber(raw.reasoningTokens),
    total: asFiniteNumber(raw.total),
  };
  const anyPresent = Object.values(buckets).some((v) => v !== null);
  return anyPresent ? buckets : null;
}

// Returns a plain usage summary for one embedded-agent turn, or null when the
// result carries no usable usage data (e.g. the runtime didn't expose
// agentMeta, or the turn never reached a model call).
function usageFromEmbeddedResult(result) {
  const meta = result?.meta;
  const agentMeta = meta?.agentMeta;
  if (!agentMeta && meta?.durationMs == null) return null;

  const usage = normalizeUsageBuckets(agentMeta?.usage);
  const lastCallUsage = normalizeUsageBuckets(agentMeta?.lastCallUsage);

  if (!usage && !lastCallUsage) return null;

  return {
    provider: agentMeta?.provider ?? null,
    model: agentMeta?.model ?? null,
    durationMs: asFiniteNumber(meta?.durationMs),
    contextTokens: asFiniteNumber(agentMeta?.contextTokens),
    usage: usage ?? null,
    lastCallUsage: lastCallUsage ?? null,
  };
}

module.exports = {
  usageFromEmbeddedResult,
  normalizeUsageBuckets,
};
