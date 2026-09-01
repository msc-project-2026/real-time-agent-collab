// ********* TEST/JUDGE-PROMPT-FREEZE.TEST.CJS *********
'use strict';

// Pins both judge prompts by hash.
//
// A judge-versus-human agreement figure describes one prompt. The grader packs
// under plugins/webex/calibration/ quote the rubric verbatim and the humans
// grade against it, so editing either SYSTEM string after the packs go out
// silently detaches the reported agreement from the judge actually running —
// and nothing else in the suite would notice, because both judges are only
// ever exercised through stubs.
//
// So this test does not assert the prompt is *good*. It asserts it has not
// moved without someone deciding it should. A deliberate revision means:
// update the hash here, bump PROMPT_VERSION alongside it, and state whether
// the existing calibration still applies.

const test = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');

const taskJudge = require('../eval/score/score-tasks-judge');
const responseJudge = require('../eval/score/score-response');

const sha256 = (value) =>
  crypto.createHash('sha256').update(value, 'utf8').digest('hex');

const FROZEN = [
  {
    label: 'task fidelity',
    module: taskJudge,
    version: 'task-fidelity/v1 (2026-08-29)',
    hash: '060fde1386e49e7b455c60d73caac5ebeac7e59fbd31a918fe26f92c16ceac97',
  },
  {
    label: 'response quality',
    module: responseJudge,
    version: 'response-quality/v1 (2026-08-29)',
    hash: '1aa28cb1f3b56fdc410cb0de397570ab89478cd9f558ac3314504c35a4b66c30',
  },
];

test('judge prompts are frozen at the version the calibration packs were built against', async (t) => {
  for (const frozen of FROZEN) {
    await t.test(`${frozen.label} prompt is unchanged`, () => {
      assert.equal(
        frozen.module.PROMPT_VERSION,
        frozen.version,
        `${frozen.label}: PROMPT_VERSION changed — update the hash below it too`
      );
      assert.equal(
        sha256(frozen.module.SYSTEM),
        frozen.hash,
        `${frozen.label}: the SYSTEM prompt changed under a version that is still ` +
          `${frozen.version}. Bump PROMPT_VERSION and this hash together, and say ` +
          `in docs/judge-calibration-plan.md whether the existing agreement figures ` +
          `still hold for the new prompt.`
      );
    });
  }
});

test('the two judges share a rubric shape but are not the same prompt', () => {
  // One calibration protocol covers both, which only works while both are on
  // the same 1-4 anchored scale — and reporting one agreement number for both
  // would only be wrong if they were ever allowed to converge into one prompt.
  for (const frozen of FROZEN) {
    for (const band of ['1 -', '2 -', '3 -', '4 -']) {
      assert.ok(
        frozen.module.SYSTEM.includes(band),
        `${frozen.label}: rubric is missing anchor "${band}"`
      );
    }
  }
  assert.notEqual(
    sha256(taskJudge.SYSTEM),
    sha256(responseJudge.SYSTEM),
    'the two judges must stay distinct prompts with distinct agreement numbers'
  );
});
