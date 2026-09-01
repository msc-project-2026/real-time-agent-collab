#!/usr/bin/env node
// ********* EVAL/SCORE/CALIBRATION-JUDGE-RUN.JS *********
'use strict';

// Sends every calibration item to the judge and records its rating, so that
// judge-versus-human agreement can be computed alongside the human-versus-human
// ceiling that calibration-report.js reports.
//
//   EVAL_JUDGE_BASE_URL=... EVAL_JUDGE_API_KEY=... \
//     node plugins/webex/eval/score/calibration-judge-run.js <bundle-dir>...
//
// Writes plugins/webex/calibration/judge-ratings.json and appends every call,
// prompt and raw response included, to calibration/judge-log.jsonl.
//
// Two properties this file exists to guarantee:
//
// 1. **The judge sees exactly what it sees in production.** The prompts are
//    built by importing score-tasks-judge.js and score-response.js and calling
//    their own buildUserPrompt, never by re-deriving the format here. A
//    re-implementation that drifted would measure a judge we do not run.
//
// 2. **The judge sees exactly what the graders saw.** Items come from
//    build-calibration-pack.js, the same module that rendered the packs, in the
//    same seeded order, so item ids line up across the judge's ratings, the
//    marker sheets and the answer key. The manifest is the backstop: if the ids
//    have moved, the fingerprints move with them.
//
// The judge has already rated the *real* items once, during scoring. Those
// verdicts are deliberately not reused. Half the set judged under scoring-run
// conditions and half under this script's would be two measurements reported as
// one, and the frozen prompts exist precisely so a single instrument can be
// claimed.

const fs = require('node:fs');
const path = require('node:path');

const { createJudge } = require('./judge-client');
const taskJudge = require('./score-tasks-judge');
const responseJudge = require('./score-response');
const {
  collect,
  buildTaskItems,
  buildResponseItems,
} = require('./build-calibration-pack');

const OUT_DIR = path.join(__dirname, '..', '..', 'calibration');
const PERTURBATIONS = path.join(__dirname, 'calibration-perturbations.json');

function conversationFor(conversations, scenarioId) {
  return conversations.byId.get(scenarioId) ?? conversations.byId.values().next().value ?? [];
}

function buildItems(bundleDirs) {
  const collected = collect(bundleDirs);
  const perturbations = JSON.parse(fs.readFileSync(PERTURBATIONS, 'utf8'));

  const expectedPoints = {};
  for (const ex of collected.responseExamples) {
    expectedPoints[`${ex.scenarioId}:${ex.questionNumber}`] = ex.points;
  }
  const conversations = { byId: collected.conversations, expectedPoints };

  const taskItems = buildTaskItems({
    taskExamples: collected.taskExamples,
    perturbations,
  }).map((ex, i) => ({
    id: `T-${i + 1}`,
    kind: ex.kind,
    judge: 'task-fidelity',
    system: taskJudge.SYSTEM,
    promptVersion: taskJudge.PROMPT_VERSION,
    user: taskJudge.buildUserPrompt({
      conversation: conversationFor(conversations, ex.scenarioId),
      citedNumbers: ex.cited ?? [],
      observedTitle: ex.title,
      observedDescription: ex.description,
      referenceTitle: ex.reference,
    }),
  }));

  const responseItems = buildResponseItems({
    responseExamples: collected.responseExamples,
    perturbations,
    conversations,
  }).map((ex, i) => ({
    id: `Q-${i + 1}`,
    kind: ex.kind,
    judge: 'response-quality',
    system: responseJudge.SYSTEM,
    promptVersion: responseJudge.PROMPT_VERSION,
    user: responseJudge.buildUserPrompt({
      // Only what the agent could have seen when it answered, matching both
      // the scoring path and what the grader packs showed.
      conversation: conversationFor(conversations, ex.scenarioId).filter(
        (m) => m.number <= ex.questionNumber
      ),
      questionNumber: ex.questionNumber,
      reply: ex.reply,
      expectedPoints: ex.points,
    }),
  }));

  return [...taskItems, ...responseItems];
}

function normaliseRating(value) {
  return Number.isInteger(value) && value >= 1 && value <= 4 ? value : null;
}

async function main() {
  const dirs = process.argv.slice(2).filter((a) => !a.startsWith('--'));
  if (dirs.length === 0) {
    console.error('Usage: calibration-judge-run.js <bundle-dir>...  (the same bundles the packs were built from)');
    process.exit(1);
  }
  const repeats = Number(
    (process.argv.find((a) => a.startsWith('--repeats=')) ?? '--repeats=1').split('=')[1]
  );

  const items = buildItems(dirs);
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const { judge, config } = createJudge({ logPath: path.join(OUT_DIR, 'judge-log.jsonl') });
  if (config.missing?.length) {
    console.error(`missing env: ${config.missing.join(', ')}`);
    process.exit(1);
  }

  console.log(`model    : ${config.model}`);
  console.log(`items    : ${items.length}  (${repeats} pass(es))\n`);

  const results = [];
  for (const item of items) {
    const ratings = [];
    for (let pass = 0; pass < repeats; pass += 1) {
      const { ok, verdict, error } = await judge({
        kind: item.judge,
        system: item.system,
        user: item.user,
      });
      ratings.push({
        pass: pass + 1,
        rating: ok ? normaliseRating(verdict.rating) : null,
        rationale: ok ? (verdict.rationale ?? null) : null,
        error: ok ? null : String(error ?? 'unknown'),
      });
    }
    const first = ratings[0];
    results.push({
      id: item.id,
      judge: item.judge,
      kind: item.kind,
      promptVersion: item.promptVersion,
      rating: first.rating,
      rationale: first.rationale,
      ratings,
    });
    const shown = ratings.map((r) => r.rating ?? 'x').join(',');
    console.log(`  ${item.id.padEnd(5)} ${item.kind.padEnd(19)} -> ${shown}`);
  }

  const unrated = results.filter((r) => r.rating === null);
  const out = path.join(OUT_DIR, 'judge-ratings.json');
  fs.writeFileSync(out, `${JSON.stringify({ model: config.model, results }, null, 2)}\n`, 'utf8');
  console.log(`\nwritten: ${out}`);
  if (unrated.length) {
    console.log(`WARNING: ${unrated.length} item(s) returned no usable rating: ${unrated.map((r) => r.id).join(', ')}`);
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

module.exports = { buildItems };
