'use strict';

const assert = require('node:assert/strict');
const { describe, test } = require('node:test');

const {
  usageFromEmbeddedResult,
  normalizeUsageBuckets,
} = require('../processing/usage/from-result');
const { summarizeUsage } = require('../processing/usage/summary');

// ---------------------------------------------------------------------------
// Phase 8 token-usage observability. Usage is read straight off the
// runEmbeddedAgent return value (no diagnostics subscription — that path is
// gated to bundled services only in this gateway version) and aggregated
// from job-log records.
// ---------------------------------------------------------------------------

describe('usageFromEmbeddedResult', () => {
  test('reads provider/model/usage/duration from meta.agentMeta', () => {
    const result = {
      meta: {
        durationMs: 4210,
        agentMeta: {
          provider: 'cisco',
          model: 'bedrock/global.anthropic.claude-haiku-4-5-20251001-v1:0',
          contextTokens: 200000,
          usage: { input: 1200, output: 340, cacheRead: 800, cacheWrite: 0, total: 1540 },
          lastCallUsage: { input: 600, output: 340, total: 940 },
        },
      },
    };

    const out = usageFromEmbeddedResult(result);
    assert.equal(out.provider, 'cisco');
    assert.match(out.model, /claude-haiku/);
    assert.equal(out.durationMs, 4210);
    assert.equal(out.contextTokens, 200000);
    assert.deepEqual(out.usage, {
      input: 1200,
      output: 340,
      cacheRead: 800,
      cacheWrite: 0,
      reasoningTokens: null,
      total: 1540,
    });
    assert.equal(out.lastCallUsage.input, 600);
  });

  test('returns null when there is no usable usage data', () => {
    assert.equal(usageFromEmbeddedResult(undefined), null);
    assert.equal(usageFromEmbeddedResult({}), null);
    assert.equal(usageFromEmbeddedResult({ meta: {} }), null);
    assert.equal(
      usageFromEmbeddedResult({ meta: { agentMeta: { provider: 'x', model: 'y' } } }),
      null
    );
  });

  test('falls back to lastCallUsage when the accumulator is absent', () => {
    const out = usageFromEmbeddedResult({
      meta: { durationMs: 10, agentMeta: { lastCallUsage: { input: 5, output: 2 } } },
    });
    assert.equal(out.usage, null);
    assert.equal(out.lastCallUsage.input, 5);
  });

  test('normalizeUsageBuckets drops non-finite values and empty objects', () => {
    assert.equal(normalizeUsageBuckets(null), null);
    assert.equal(normalizeUsageBuckets({}), null);
    assert.equal(normalizeUsageBuckets({ input: 'nope' }), null);
    assert.deepEqual(normalizeUsageBuckets({ input: 3, output: NaN }), {
      input: 3,
      output: null,
      cacheRead: null,
      cacheWrite: null,
      reasoningTokens: null,
      total: null,
    });
  });
});

describe('summarizeUsage', () => {
  const records = [
    { step: 'gate', usage: { provider: 'cisco', model: 'haiku', durationMs: 1000, usage: { input: 100, output: 20, total: 120 } } },
    { step: 'extract', usage: { provider: 'cisco', model: 'haiku', durationMs: 3000, usage: { input: 500, output: 80, cacheRead: 200, total: 780 } } },
    { step: 'respond', usage: { provider: 'cisco', model: 'haiku', durationMs: 2000, usage: { input: 300, output: 150, total: 450 } } },
    { step: 'gate', usage: { provider: 'cisco', model: 'haiku', durationMs: 900, usage: { input: 90, output: 15, total: 105 } } },
    { step: 'task-notify' }, // deterministic step — no usage
  ];

  test('aggregates per step and in total', () => {
    const { byStep, total } = summarizeUsage(records);

    assert.equal(byStep.gate.calls, 2);
    assert.equal(byStep.gate.input, 190);
    assert.equal(byStep.gate.output, 35);
    assert.equal(byStep.gate.durationMs, 1900);

    assert.equal(byStep.extract.calls, 1);
    assert.equal(byStep.extract.cacheRead, 200);

    assert.equal(total.calls, 4);
    assert.equal(total.input, 990);
    assert.equal(total.output, 265);
    assert.equal(total.total, 1455);
  });

  // The provider's own `total` is overwritten with the last call's total by
  // the embedded-agent runtime, so on a multi-call turn it can be far lower
  // than input alone. `total` must therefore be computed from the billed
  // buckets, never taken from the provider. Confirmed live on the first
  // smoke run (gate: input 37453, output 221, reported total 18847).
  test('computes total from billed buckets, ignoring an implausible provider total', () => {
    const { total } = summarizeUsage([
      {
        step: 'gate',
        usage: {
          provider: 'cisco',
          model: 'haiku',
          durationMs: 5000,
          usage: { input: 37453, output: 221, cacheRead: 0, cacheWrite: 0, total: 18847 },
        },
      },
    ]);

    assert.equal(total.total, 37674, 'total is input + output + cache buckets');
    assert.equal(total.providerReportedTotal, 18847, 'raw provider total kept for comparison');
  });

  test('orders known steps in pipeline order', () => {
    const { byStep } = summarizeUsage(records);
    assert.deepEqual(Object.keys(byStep), ['gate', 'extract', 'respond']);
  });

  test('groups by provider/model', () => {
    const { models } = summarizeUsage(records);
    assert.equal(models['cisco/haiku'].calls, 4);
  });

  test('tolerates empty / non-array input', () => {
    assert.deepEqual(summarizeUsage(null).total.calls, 0);
    assert.deepEqual(summarizeUsage([]).byStep, {});
  });
});
