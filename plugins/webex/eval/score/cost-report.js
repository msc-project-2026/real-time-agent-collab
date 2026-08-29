#!/usr/bin/env node
// ********* EVAL/SCORE/COST-REPORT.JS *********
'use strict';

// Aggregates token usage across runs into a cost table and a scale
// projection, as Markdown.
//
//   node plugins/webex/eval/score/cost-report.js <bundle-dir>...
//     [--rate-in <$/MTok>] [--rate-out <$/MTok>] [--spaces N] [--messages M]
//
// Rates are a required *input*, not a constant baked in here. The deployment
// reaches Claude through a third-party LiteLLM proxy to Bedrock, so neither
// Anthropic's first-party rates nor Bedrock's published ones are guaranteed
// to be what this project is billed. Whatever figure is used has to be stated
// alongside the result rather than implied by it — defaults below are
// Anthropic's published Haiku 4.5 rates, which makes the numbers an
// order-of-magnitude estimate, not an invoice.
//
// Token counts themselves are measured, not estimated: they come from each
// step's own `usage` record in the job log.

const fs = require('node:fs');
const path = require('node:path');

const { summarizeUsage } = require('../../processing/usage/summary');

const DEFAULTS = {
  rateIn: 1.0,    // $/MTok input,  Claude Haiku 4.5 first-party list price
  rateOut: 5.0,   // $/MTok output, same
  spaces: 50,     // projection: concurrently active spaces
  messages: 40,   // projection: messages per space per working day
};

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? Number(process.argv[i + 1]) : fallback;
}

function loadBundle(target) {
  const stat = fs.statSync(target);
  const file = stat.isDirectory() ? path.join(target, 'bundle.json') : target;
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function money(v) {
  return v < 0.01 ? `$${v.toFixed(4)}` : `$${v.toFixed(2)}`;
}

function num(v) {
  return Math.round(v).toLocaleString('en-GB');
}

function main() {
  const dirs = process.argv.slice(2).filter((a) => !a.startsWith('--') && !/^[\d.]+$/.test(a));
  if (dirs.length === 0) {
    console.error('Usage: node eval/score/cost-report.js <bundle-dir>... [--rate-in N] [--rate-out N] [--spaces N] [--messages N]');
    process.exit(1);
  }

  const rateIn = arg('rate-in', DEFAULTS.rateIn);
  const rateOut = arg('rate-out', DEFAULTS.rateOut);
  const spaces = arg('spaces', DEFAULTS.spaces);
  const perDay = arg('messages', DEFAULTS.messages);

  // Grouped by scenario: a 7-message and a 25-message scenario have very
  // different per-run totals, and averaging across them would describe
  // neither.
  const byScenario = new Map();
  for (const dir of dirs) {
    const b = loadBundle(dir);
    const id = b.meta?.scenarioId ?? 'unknown';
    const entry = byScenario.get(id) ?? { runs: [], messages: b.scenario?.messages?.length ?? 0 };
    entry.runs.push(summarizeUsage(b.jobs ?? []));
    byScenario.set(id, entry);
  }

  const out = [];
  out.push('## Token usage and cost', '');
  out.push(
    `Measured over ${dirs.length} run(s). Costed at $${rateIn}/MTok input and $${rateOut}/MTok ` +
      'output (Claude Haiku 4.5 list price). The deployment reaches the model through a ' +
      'third-party proxy, so these are order-of-magnitude estimates rather than billed amounts.',
    ''
  );

  const perMsg = []; // { input, output } per message, per scenario

  for (const [scenarioId, { runs, messages }] of byScenario) {
    const steps = {};
    for (const run of runs) {
      for (const [step, b] of Object.entries(run.byStep)) {
        steps[step] = steps[step] ?? { calls: 0, input: 0, output: 0 };
        steps[step].calls += b.calls;
        steps[step].input += b.input;
        steps[step].output += b.output;
      }
    }
    const n = runs.length;
    out.push(`### ${scenarioId} — ${messages} messages, ${n} run(s)`, '');
    out.push('| Step | Calls/run | Input/run | Output/run | Cost/run |', '|---|---|---|---|---|');

    let totIn = 0;
    let totOut = 0;
    let totCalls = 0;
    for (const [step, b] of Object.entries(steps)) {
      const i = b.input / n;
      const o = b.output / n;
      totIn += i;
      totOut += o;
      totCalls += b.calls / n;
      const cost = (i / 1e6) * rateIn + (o / 1e6) * rateOut;
      out.push(`| ${step} | ${(b.calls / n).toFixed(1)} | ${num(i)} | ${num(o)} | ${money(cost)} |`);
    }
    const runCost = (totIn / 1e6) * rateIn + (totOut / 1e6) * rateOut;
    out.push(
      `| **total** | **${totCalls.toFixed(1)}** | **${num(totIn)}** | **${num(totOut)}** | **${money(runCost)}** |`,
      ''
    );
    const perMsgIn = totIn / messages;
    perMsg.push({ input: perMsgIn, output: totOut / messages });
    out.push(
      `Per message: ${num(perMsgIn)} input tokens, ${money(runCost / messages)}. ` +
        `Output is ${((totOut / (totIn + totOut)) * 100).toFixed(1)}% of tokens.`,
      ''
    );
  }

  const mean = (k) => perMsg.reduce((a, b) => a + b[k], 0) / perMsg.length;
  const meanIn = mean('input');
  const meanOut = mean('output');
  // Output is a small share of *tokens* but is priced several times higher,
  // so it is a non-trivial share of cost and cannot be dropped from the
  // projection the way it can from a token count.
  const costIn = (meanIn / 1e6) * rateIn;
  const costOut = (meanOut / 1e6) * rateOut;
  const perMsgCost = costIn + costOut;
  const monthly = perMsgCost * perDay * spaces * 22;

  out.push('### Projected at scale', '');
  out.push(
    `Per message: ${num(meanIn)} input + ${num(meanOut)} output tokens ` +
      `(${money(costIn)} + ${money(costOut)} = ${money(perMsgCost)}), mean across scenarios. ` +
      `Output is ${((meanOut / (meanIn + meanOut)) * 100).toFixed(1)}% of tokens but ` +
      `${((costOut / perMsgCost) * 100).toFixed(1)}% of cost.`,
    '',
    `${spaces} active spaces averaging ${perDay} messages per working day: ` +
      `**${money(monthly)}/month** over 22 working days.`,
    ''
  );
  out.push(
    'Input dominates the token count, which is why the per-call overhead reductions moved ' +
      'the total and shortening prompts would not have. It does not dominate cost to the ' +
      'same degree: output is priced several times higher, so its share of spend is well ' +
      'above its share of tokens.',
    ''
  );

  console.log(out.join('\n'));
}

if (require.main === module) main();
