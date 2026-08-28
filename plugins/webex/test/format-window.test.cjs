'use strict';

const assert = require('node:assert/strict');
const { describe, test } = require('node:test');

const {
  formatWindowSections,
  formatMemberEntry,
  resolveAssigneeDisplay,
  formatTaskEntry,
} = require('../processing/format-window');

// ---------------------------------------------------------------------------
// Category: format-window.js — the shared window-rendering logic behind
// respond-instruction.js and extract-instruction.js. The property under test
// here is the one that actually matters for correctness: `processing` isn't
// exclusive to one flow (layer 2a only serializes gate+flush per thread, not
// space-wide — see run-message-flow.js), so a sibling flow's batch can be
// sitting in the same array. Only entries in the caller's own `messageIds`
// may end up in `batch`; `pending` is never surfaced at all.
// ---------------------------------------------------------------------------

describe('formatWindowSections', () => {
  test('history includes all of processed, unfiltered', () => {
    const window = {
      processed: [
        { id: 'p-1', content: 'old message' },
        { id: 'p-2', content: 'older message' },
      ],
      processing: [],
      pending: [],
    };

    const sections = formatWindowSections({ window, messageIds: [] });

    assert.deepEqual(sections.history.map((e) => e.id), ['p-1', 'p-2']);
  });

  test('batch is filtered to only this flow\'s own messageIds, excluding a sibling flow\'s entries', () => {
    const window = {
      processed: [],
      processing: [
        { id: 'mine-1', content: 'my message' },
        { id: 'sibling-1', content: "another flow's message, running concurrently" },
        { id: 'mine-2', content: 'my other message' },
      ],
      pending: [],
    };

    const sections = formatWindowSections({ window, messageIds: ['mine-1', 'mine-2'] });

    assert.deepEqual(
      sections.batch.map((e) => e.id).sort(),
      ['mine-1', 'mine-2']
    );
    assert.ok(!sections.batch.some((e) => e.id === 'sibling-1'));
  });

  test('pending is never surfaced, even if it would match messageIds', () => {
    const window = {
      processed: [],
      processing: [],
      pending: [{ id: 'future-1', content: "next flow's backlog" }],
    };

    // Deliberately pass an id that only exists in `pending`, not `processing`
    // — it must not appear anywhere in the output.
    const sections = formatWindowSections({ window, messageIds: ['future-1'] });

    assert.deepEqual(sections.batch, []);
    assert.ok(!('pending' in sections));
  });

  test('missing messageIds throws rather than silently showing everything', () => {
    const window = { processed: [], processing: [{ id: 'p-1' }], pending: [] };

    assert.throws(() => formatWindowSections({ window }), /messageIds/);
  });

  test('missing/malformed window arrays default to empty, not a throw', () => {
    const sections = formatWindowSections({ window: {}, messageIds: ['x'] });

    assert.deepEqual(sections.history, []);
    assert.deepEqual(sections.batch, []);
  });

  test('entry formatting strips storage-internal fields down to what the model needs', () => {
    const window = {
      processed: [],
      processing: [
        {
          id: 'msg-1',
          threadId: 'thread-x',
          senderId: 'person-1',
          senderName: 'Ada',
          content: 'hello',
          botIsMentioned: true,
          datetime: '2026-01-01T00:00:00.000Z',
        },
      ],
      pending: [],
    };

    const sections = formatWindowSections({ window, messageIds: ['msg-1'] });

    assert.deepEqual(sections.batch[0], {
      id: 'msg-1',
      senderName: 'Ada',
      text: 'hello',
      botIsMentioned: true,
      datetime: '2026-01-01T00:00:00.000Z',
    });
  });
});

// ---------------------------------------------------------------------------
// Category: formatMemberEntry — the one {id, name} shape every step's
// "Space members" section renders, regardless of what else (email, source)
// the underlying cached member record carries.
// ---------------------------------------------------------------------------

describe('formatMemberEntry', () => {
  test('strips everything but id and name', () => {
    assert.deepEqual(
      formatMemberEntry({ id: 'person-1', name: 'Ada', email: 'ada@example.com', source: 'webex' }),
      { id: 'person-1', name: 'Ada' }
    );
  });
});

// ---------------------------------------------------------------------------
// Category: resolveAssigneeDisplay / formatTaskEntry — the Active-tasks
// id->name resolution, mirroring board/src/model.js's own resolveAssigneeName
// so a human and the model land on the same answer for the same task.
// ---------------------------------------------------------------------------

describe('resolveAssigneeDisplay', () => {
  const members = [{ id: 'person-1', name: 'Ada' }];

  test('resolves a matching member id to their name', () => {
    assert.equal(resolveAssigneeDisplay('person-1', members), 'Ada');
  });

  test('falls back to the raw value when nothing matches (agent, unknown, free-text name)', () => {
    assert.equal(resolveAssigneeDisplay('agent', members), 'agent');
    assert.equal(resolveAssigneeDisplay('unknown', members), 'unknown');
    assert.equal(resolveAssigneeDisplay('Someone Not In The Space', members), 'Someone Not In The Space');
  });

  test('passes through falsy values untouched', () => {
    assert.equal(resolveAssigneeDisplay(undefined, members), undefined);
    assert.equal(resolveAssigneeDisplay(null, members), null);
    assert.equal(resolveAssigneeDisplay('', members), '');
  });

  test('tolerates a missing/non-array members list', () => {
    assert.equal(resolveAssigneeDisplay('person-1', undefined), 'person-1');
  });
});

describe('formatTaskEntry', () => {
  test('renders the full shared field set with assigned resolved to a name', () => {
    const task = {
      id: 'task_1',
      title: 'Fix login test',
      description: 'Flaky on CI',
      type: 'development',
      status: 'backlog',
      assigned: 'person-1',
      deadline: '2026-09-01',
      child_tasks: ['task_2'],
    };
    const members = [{ id: 'person-1', name: 'Ada' }];

    assert.deepEqual(formatTaskEntry(task, members), {
      id: 'task_1',
      title: 'Fix login test',
      description: 'Flaky on CI',
      type: 'development',
      status: 'backlog',
      assigned: 'Ada',
      deadline: '2026-09-01',
      child_tasks: ['task_2'],
    });
  });

  test('leaves assigned as-is when it does not match a real member (agent, unknown, free text)', () => {
    const task = { id: 'task_1', title: 'x', type: 'development', status: 'backlog', assigned: 'agent' };

    assert.equal(formatTaskEntry(task, []).assigned, 'agent');
  });
});
