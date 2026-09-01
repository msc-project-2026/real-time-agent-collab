// ********* TEST/CALIBRATION-PACK.TEST.CJS *********
'use strict';

// The grader packs go to humans and come back as the only human labels this
// project will get. Two properties have to hold or the returned sheets are not
// comparable, and neither is visible by eyeballing a 900-line markdown file.

const { describe, test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const {
  seededShuffle,
  selectRealTasks,
  buildTaskItems,
  buildResponseItems,
} = require('../eval/score/build-calibration-pack');

const PERTURBATIONS = JSON.parse(
  fs.readFileSync(path.join(__dirname, '..', 'eval', 'score', 'calibration-perturbations.json'), 'utf8')
);

describe('seededShuffle', () => {
  // Both markers must rate the same instrument, and a grader part-way through a
  // pack that gets rebuilt must not find the items renumbered underneath them.
  test('is deterministic for a given seed', () => {
    const input = Array.from({ length: 20 }, (_, i) => i);
    assert.deepEqual(seededShuffle(input, 42), seededShuffle(input, 42));
  });

  test('actually shuffles, and preserves every item', () => {
    const input = Array.from({ length: 20 }, (_, i) => i);
    const out = seededShuffle(input, 42);
    assert.notDeepEqual(out, input);
    assert.deepEqual([...out].sort((a, b) => a - b), input);
  });

  test('does not mutate its input', () => {
    const input = [1, 2, 3, 4, 5];
    seededShuffle(input, 7);
    assert.deepEqual(input, [1, 2, 3, 4, 5]);
  });
});

describe('selectRealTasks', () => {
  // Three runs of one scenario produce the same handful of tasks three times
  // over. Grading eight phrasings of one task measures nothing, so the cap has
  // to spread across distinct tasks rather than take the first eight.
  const pool = [];
  for (const ref of ['rename export', 'permissions', 'empty state', 'analytics', 'preview label']) {
    for (const run of ['r1', 'r2', 'r3']) {
      pool.push({ reference: ref, title: `${ref} (${run})`, runId: run });
    }
  }

  test('spreads across distinct reference titles before repeating any', () => {
    const picked = selectRealTasks(pool, 5);
    assert.equal(picked.length, 5);
    assert.equal(new Set(picked.map((p) => p.reference)).size, 5);
  });

  test('caps the total and stays balanced past the number of distinct tasks', () => {
    const picked = selectRealTasks(pool, 8);
    assert.equal(picked.length, 8);
    const counts = {};
    for (const p of picked) counts[p.reference] = (counts[p.reference] ?? 0) + 1;
    // 8 across 5 groups: no group may take three while another has one.
    assert.ok(Math.max(...Object.values(counts)) - Math.min(...Object.values(counts)) <= 1);
  });

  test('returns everything when the pool is smaller than the cap', () => {
    assert.equal(selectRealTasks(pool.slice(0, 3), 8).length, 3);
  });
});

describe('pack composition', () => {
  const taskExamples = Array.from({ length: 13 }, (_, i) => ({
    scenarioId: 'eval-s01-release-readiness',
    runId: `r${i % 3}`,
    reference: `ref-${i % 5}`,
    title: `title ${i}`,
    description: `desc ${i}`,
    cited: [1, 2],
  }));

  test('real, wrong and correct thirds are all present and roughly balanced', () => {
    const items = buildTaskItems({ taskExamples, perturbations: PERTURBATIONS });
    const kinds = {};
    for (const i of items) kinds[i.kind] = (kinds[i.kind] ?? 0) + 1;
    assert.equal(kinds.real, 8);
    assert.equal(kinds['perturbed-wrong'], PERTURBATIONS.taskFidelity.wrong.length);
    assert.equal(kinds['perturbed-correct'], PERTURBATIONS.taskFidelity.correct.length);
  });

  test('real and constructed examples are interleaved, not grouped', () => {
    const items = buildTaskItems({ taskExamples, perturbations: PERTURBATIONS });
    const kinds = items.map((i) => i.kind);
    // If they were grouped, every real example would sit in one contiguous run.
    const firstReal = kinds.indexOf('real');
    const lastReal = kinds.lastIndexOf('real');
    const realCount = kinds.filter((k) => k === 'real').length;
    assert.ok(
      lastReal - firstReal + 1 > realCount,
      'real examples form a contiguous block — a grader could read the answer off the ordering'
    );
  });

  // A grader must see the identical checklist the judge does. A constructed
  // reply written against question 25 that arrives with question 22's expected
  // points is not a harder example, it is an unratable one.
  test('constructed replies inherit the expected points of the question they answer', () => {
    const responseExamples = [
      { scenarioId: 'eval-s01-release-readiness', runId: 'r0', questionNumber: 22, reply: 'a', points: ['P22'] },
      { scenarioId: 'eval-s01-release-readiness', runId: 'r0', questionNumber: 25, reply: 'b', points: ['P25'] },
    ];
    const conversations = {
      byId: new Map([['eval-s01-release-readiness', []]]),
      expectedPoints: {
        'eval-s01-release-readiness:22': ['P22'],
        'eval-s01-release-readiness:25': ['P25'],
      },
    };
    const items = buildResponseItems({ responseExamples, perturbations: PERTURBATIONS, conversations });
    for (const item of items.filter((i) => i.kind !== 'real')) {
      assert.deepEqual(
        item.points,
        [`P${item.questionNumber}`],
        `constructed item for question ${item.questionNumber} got the wrong expected points`
      );
    }
  });

  test('every constructed example carries the metadata the answer key needs', () => {
    const items = buildTaskItems({ taskExamples, perturbations: PERTURBATIONS });
    for (const item of items.filter((i) => i.kind !== 'real')) {
      assert.ok(item.perturbation, 'missing perturbation label');
      assert.ok(item.expected, 'missing expected band');
      assert.ok(item.why, 'missing rationale');
    }
  });
});
