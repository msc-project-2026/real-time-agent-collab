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

// Compact breakdown of what the runtime actually put in the system prompt.
//
// Exists because the first live smoke run showed ~18.7k input tokens per
// model call against a gate instruction of only ~1.5k tokens, i.e. the
// overwhelming majority of spend is fixed per-call overhead rather than
// conversation content. Attributing that split is a reportable result in its
// own right, so it is captured per step rather than diagnosed ad hoc.
//
// `meta.systemPromptReport` is built by the runtime's own
// buildSystemPromptReport and measured in characters, not tokens. Only sizes
// and names are kept here, never prompt text: these records are archived per
// space and the prompts contain user message content.
function promptBreakdownFromResult(result) {
  const report = result?.meta?.systemPromptReport;
  if (!report || typeof report !== 'object') return null;

  // Shape confirmed against the deployed bundle's own buildSystemPromptReport
  // (system-prompt-report-*.js): the size fields are nested under
  // `systemPrompt`, `tools` and `skills`, not top level. A first attempt read
  // them as top-level keys and captured nothing but nulls.
  const toolEntries = Array.isArray(report.tools?.entries) ? report.tools.entries : [];
  const skillEntries = Array.isArray(report.skills?.entries) ? report.skills.entries : [];

  return {
    systemPromptChars: asFiniteNumber(report.systemPrompt?.chars),
    projectContextChars: asFiniteNumber(report.systemPrompt?.projectContextChars),
    nonProjectContextChars: asFiniteNumber(report.systemPrompt?.nonProjectContextChars),
    toolsSchemaChars: asFiniteNumber(report.tools?.schemaChars),
    toolCount: toolEntries.length,
    toolNames: toolEntries.map((tool) => tool?.name ?? null).filter(Boolean),
    skillsPromptChars: asFiniteNumber(report.skills?.promptChars),
    skillCount: skillEntries.length,
    skillNames: skillEntries.map((skill) => skill?.name ?? null).filter(Boolean),
    injectedWorkspaceFiles: report.injectedWorkspaceFiles ?? null,
  };
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
    prompt: promptBreakdownFromResult(result),
  };
}

module.exports = {
  usageFromEmbeddedResult,
  normalizeUsageBuckets,
  promptBreakdownFromResult,
};
