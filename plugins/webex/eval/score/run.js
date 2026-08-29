#!/usr/bin/env node
// ********* EVAL/SCORE/RUN.JS *********
'use strict';

// Offline scorer for an eval bundle. Runs nowhere near the gateway: it reads
// a bundle written by eval/run-scenario.js and writes a scorecard beside it.
//
//   node plugins/webex/eval/score/run.js <bundle.json | bundle-dir> [--no-judge]
//
// Judge calls need:
//   EVAL_JUDGE_BASE_URL   e.g. https://llm-proxy.dev.outshift.ai/
//   EVAL_JUDGE_API_KEY
//   EVAL_JUDGE_MODEL      optional, defaults to Sonnet 4.6 via that proxy
//
// Without them the deterministic scorers still run and the judge sections
// report as unjudged, so a scorecard is always produced.
//
// Writes, next to the bundle: scorecard.json, scorecard.md, judge-log.jsonl.

const fs = require('node:fs/promises');
const path = require('node:path');

const { scoreGate } = require('./score-gate');
const { scoreTasks } = require('./score-tasks');
const { scoreTasksJudge } = require('./score-tasks-judge');
const { scoreResponse } = require('./score-response');
const { createJudge } = require('./judge-client');
const { buildScorecard, renderMarkdown } = require('./score-summary');

async function resolveBundlePath(target) {
  const stat = await fs.stat(target);
  return stat.isDirectory() ? path.join(target, 'bundle.json') : target;
}

async function main() {
  const args = process.argv.slice(2);
  const target = args.find((a) => !a.startsWith('--'));
  const noJudge = args.includes('--no-judge');

  if (!target) {
    console.error('Usage: node eval/score/run.js <bundle.json | bundle-dir> [--no-judge]');
    process.exit(1);
  }

  const bundlePath = await resolveBundlePath(path.resolve(target));
  const outDir = path.dirname(bundlePath);
  const bundle = JSON.parse(await fs.readFile(bundlePath, 'utf8'));

  const gate = scoreGate(bundle);
  const tasks = scoreTasks(bundle);

  let tasksJudge = null;
  let response = null;
  if (!noJudge) {
    const { judge, config } = createJudge({ logPath: path.join(outDir, 'judge-log.jsonl') });
    if (config.missing.length > 0) {
      console.warn(
        `[score] judge disabled — missing env: ${config.missing.join(', ')} (deterministic scores still produced)`
      );
    }
    tasksJudge = await scoreTasksJudge({ bundle, taskScore: tasks, judge });
    response = await scoreResponse({ bundle, judge });
  }

  const scorecard = buildScorecard({ bundle, gate, tasks, tasksJudge, response });
  const markdown = renderMarkdown({ scorecard, gate, tasks, tasksJudge, response });

  await fs.writeFile(
    path.join(outDir, 'scorecard.json'),
    `${JSON.stringify({ scorecard, gate, tasks, tasksJudge, response }, null, 2)}\n`,
    'utf8'
  );
  await fs.writeFile(path.join(outDir, 'scorecard.md'), `${markdown}\n`, 'utf8');

  console.log(markdown);
  console.log(`\n[score] written to ${outDir}`);
}

main().catch((err) => {
  console.error('[score] fatal:', err?.stack ?? err);
  process.exit(1);
});
