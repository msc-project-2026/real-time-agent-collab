'use strict';

const assert = require('node:assert/strict');
const { describe, test } = require('node:test');

const { scoreGate } = require('../eval/score/score-gate');
const { scoreTasks } = require('../eval/score/score-tasks');
const { scoreTasksJudge } = require('../eval/score/score-tasks-judge');
const { parseJsonLoose, createJudge } = require('../eval/score/judge-client');

// ---------------------------------------------------------------------------
// Phase 8 scoring. The deterministic scorers are the contract that turns a
// bundle into report numbers, so they are tested against hand-built bundles
// rather than live output — a live run cannot produce a controlled miss.
// ---------------------------------------------------------------------------

const SCENARIO_ID = 'sc';
const mid = (n) => `${SCENARIO_ID}-msg-${n}`;

function bundle({ messages = [], expectedTasks = [], updates = [], tasks = [], gateValidation = [] } = {}) {
  return {
    meta: { scenarioId: SCENARIO_ID, variant: 'baseline', evalRunId: 'r1' },
    scenario: { id: SCENARIO_ID, messages, expectedTasks, updates },
    tasks,
    gateValidation,
    jobs: [],
    usageSummary: { byStep: {}, total: null },
  };
}

describe('scoreGate', () => {
  test('scores both tag fields per message and builds a confusion matrix', () => {
    const result = scoreGate(
      bundle({
        messages: [
          { number: 1, expectedTags: { isAddressed: false, configRequest: false } },
          { number: 2, expectedTags: { isAddressed: true, configRequest: false } },
          { number: 3, expectedTags: { isAddressed: false, configRequest: true } },
        ],
        gateValidation: [
          { messageId: mid(1), messageTags: { isAddressed: false, configRequest: false } },
          { messageId: mid(2), messageTags: { isAddressed: true, configRequest: false } },
          // wrong on configRequest: a false negative
          { messageId: mid(3), messageTags: { isAddressed: false, configRequest: false } },
        ],
      })
    );

    assert.equal(result.overall.messagesScored, 3);
    assert.equal(result.overall.fullyCorrect, 2);
    assert.equal(result.byField.isAddressed.accuracy, 1);
    assert.equal(result.byField.configRequest.falseNegative, 1);
    assert.equal(result.byField.configRequest.accuracy, 2 / 3);
  });

  test('a message the gate never ran on is reported, not silently skipped', () => {
    const result = scoreGate(
      bundle({
        messages: [{ number: 1, expectedTags: { isAddressed: false, configRequest: false } }],
        gateValidation: [],
      })
    );

    assert.equal(result.overall.messagesMissingGateRun, 1);
    assert.equal(result.overall.messagesScored, 0);
    assert.equal(result.messages[0].missing, true);
  });

  test('messages without expectedTags are ignored entirely', () => {
    const result = scoreGate(
      bundle({ messages: [{ number: 1 }], gateValidation: [] })
    );
    assert.equal(result.overall.messagesScored, 0);
    assert.equal(result.overall.messagesMissingGateRun, 0);
  });
});

describe('scoreTasks', () => {
  const expectedTasks = [
    {
      id: 'task-01',
      title: 'Rename the export button',
      type: 'development',
      evidenceMessages: [2, 3],
      expectedStatus: 'done',
      expectedAssigned: 'ben',
    },
    {
      id: 'task-02',
      title: 'Restrict manager visibility',
      type: 'development',
      evidenceMessages: [5],
      expectedStatus: 'unapproved',
      expectedAssigned: 'agent',
    },
  ];

  test('matches on evidence overlap, not title wording', () => {
    const result = scoreTasks(
      bundle({
        expectedTasks,
        tasks: [
          {
            id: 't1',
            // Deliberately worded nothing like the fixture title.
            title: 'Export control label mismatch fix',
            type: 'development',
            status: 'done',
            assigned: 'ben',
            message_ids: [mid(2), mid(3)],
          },
          {
            id: 't2',
            title: 'Permissions work',
            type: 'development',
            status: 'unapproved',
            assigned: 'agent',
            message_ids: [mid(5)],
          },
        ],
      })
    );

    assert.equal(result.overall.matched, 2);
    assert.equal(result.overall.missing, 0);
    assert.equal(result.overall.spurious, 0);
    assert.equal(result.overall.fieldsAllCorrect, 2);
  });

  test('reports a wrong assignee as a field miss while still matching the task', () => {
    const result = scoreTasks(
      bundle({
        expectedTasks: [expectedTasks[0]],
        tasks: [
          {
            id: 't1',
            title: 'Rename the export button',
            type: 'development',
            status: 'done',
            assigned: 'agent', // expected 'ben'
            message_ids: [mid(2), mid(3)],
          },
        ],
      })
    );

    assert.equal(result.overall.matched, 1);
    assert.equal(result.matched[0].fields.assigned.correct, false);
    assert.equal(result.matched[0].fieldsCorrect, false);
    assert.equal(result.overall.byField.assigned.correct, 0);
    assert.equal(result.overall.byField.type.correct, 1);
  });

  test('counts an unmatched expectation as missing and an unmatched extraction as spurious', () => {
    const result = scoreTasks(
      bundle({
        expectedTasks: [expectedTasks[0]],
        tasks: [
          { id: 't9', title: 'Coffee machine', type: 'development', message_ids: [mid(4)] },
        ],
      })
    );

    assert.equal(result.overall.matched, 0);
    assert.deepEqual(result.missing.map((m) => m.expectedId), ['task-01']);
    assert.deepEqual(result.spurious.map((m) => m.observedId), ['t9']);
  });

  test('an update hits only when the status is right AND the triggering message is cited', () => {
    const base = {
      expectedTasks: [expectedTasks[0]],
      updates: [{ taskId: 'task-01', afterMessage: 6, expectedStatus: 'done' }],
    };

    const hit = scoreTasks(
      bundle({
        ...base,
        tasks: [
          {
            id: 't1',
            title: 'Rename',
            type: 'development',
            status: 'done',
            assigned: 'ben',
            message_ids: [mid(2), mid(3), mid(6)],
          },
        ],
      })
    );
    assert.equal(hit.overall.updateHits, 1);

    // Right status, but the task never cited the message that caused it.
    const noCitation = scoreTasks(
      bundle({
        ...base,
        tasks: [
          {
            id: 't1',
            title: 'Rename',
            type: 'development',
            status: 'done',
            assigned: 'ben',
            message_ids: [mid(2), mid(3)],
          },
        ],
      })
    );
    assert.equal(noCitation.overall.updateHits, 0);
    assert.equal(noCitation.updates[0].statusOk, true);
    assert.equal(noCitation.updates[0].citesTrigger, false);
  });
});

describe('judge client', () => {
  test('parses bare, fenced, and prose-wrapped JSON', () => {
    assert.deepEqual(parseJsonLoose('{"verdict":"pass"}'), { verdict: 'pass' });
    assert.deepEqual(parseJsonLoose('```json\n{"verdict":"fail"}\n```'), { verdict: 'fail' });
    assert.deepEqual(parseJsonLoose('Sure! {"verdict":"pass"} hope that helps'), {
      verdict: 'pass',
    });
    assert.equal(parseJsonLoose('no json at all'), null);
  });

  test('reports missing credentials instead of throwing', async () => {
    const { judge } = createJudge({ env: {} });
    const result = await judge({ kind: 'x', system: 's', user: 'u' });
    assert.equal(result.ok, false);
    assert.match(result.error, /EVAL_JUDGE_BASE_URL/);
  });
});

describe('scoreTasksJudge', () => {
  test('judges each matched pair and aggregates the pass rate', async () => {
    const b = bundle({
      messages: [
        { number: 2, sender: 'Ben', text: 'The export button is misleading.' },
        { number: 3, sender: 'Maya', text: 'Rename it to export filtered results.' },
      ],
      expectedTasks: [
        {
          id: 'task-01',
          title: 'Rename the export button',
          type: 'development',
          evidenceMessages: [2, 3],
        },
      ],
      tasks: [
        {
          id: 't1',
          title: 'Rename export button',
          description: null,
          type: 'development',
          message_ids: [mid(2), mid(3)],
        },
      ],
    });
    const taskScore = scoreTasks(b);

    const seen = [];
    const judge = async ({ user }) => {
      seen.push(user);
      return { ok: true, verdict: { verdict: 'pass', score: 0.9, rationale: 'faithful' } };
    };

    const result = await scoreTasksJudge({ bundle: b, taskScore, judge });

    assert.equal(result.overall.pairs, 1);
    assert.equal(result.overall.passed, 1);
    assert.equal(result.overall.passRate, 1);
    assert.equal(result.results[0].rationale, 'faithful');
    // The judge must see the actual conversation, not just message ids.
    assert.match(seen[0], /The export button is misleading/);
    assert.match(seen[0], /Rename it to export filtered results/);
  });

  // Regression guard for a real judge-harness bug: the first live judge run
  // failed a task for "inventing" wording that was verbatim in a message the
  // judge had never been shown, because only cited-evidence messages were
  // included. Extraction sees the whole thread, so the judge must too.
  test('the judge sees uncited messages too, with cited ones marked', async (t) => {
    const b = bundle({
      messages: [
        { number: 1, sender: 'Maya', text: 'Sync on the reporting dashboard before Thursday.' },
        { number: 5, sender: 'Maya', text: 'Managers should only see their own accounts.' },
      ],
      expectedTasks: [
        { id: 'task-02', title: 'Restrict visibility', type: 'development', evidenceMessages: [5] },
      ],
      tasks: [
        {
          id: 't2',
          title: 'Restrict manager visibility in the reporting dashboard',
          type: 'development',
          message_ids: [mid(5)],
        },
      ],
    });
    const taskScore = scoreTasks(b);

    let prompt = null;
    const judge = async ({ user }) => {
      prompt = user;
      return { ok: true, verdict: { verdict: 'pass', score: 1, rationale: 'ok' } };
    };
    await scoreTasksJudge({ bundle: b, taskScore, judge });

    // Message 1 is not cited, but must still be visible as context.
    assert.match(prompt, /reporting dashboard before Thursday/);
    // Cited lines are marked, uncited ones are not.
    assert.match(prompt, /->\s*\[5\]/);
    assert.doesNotMatch(prompt, /->\s*\[1\]/);
  });

  test('a failed judge call is recorded as unjudged rather than aborting the run', async () => {
    const b = bundle({
      messages: [{ number: 2, sender: 'Ben', text: 'x' }],
      expectedTasks: [{ id: 'task-01', title: 'T', type: 'development', evidenceMessages: [2] }],
      tasks: [{ id: 't1', title: 'T', type: 'development', message_ids: [mid(2)] }],
    });
    const taskScore = scoreTasks(b);
    const judge = async () => ({ ok: false, verdict: null, error: 'boom' });

    const result = await scoreTasksJudge({ bundle: b, taskScore, judge });

    assert.equal(result.overall.judged, 0);
    assert.equal(result.overall.unjudged, 1);
    assert.equal(result.results[0].error, 'boom');
    assert.equal(result.overall.passRate, null);
  });
});
