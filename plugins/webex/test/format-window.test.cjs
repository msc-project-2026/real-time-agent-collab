'use strict';

const assert = require('node:assert/strict');
const { describe, test } = require('node:test');

const { formatWindowSections } = require('../processing/format-window');

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
      content: 'hello',
      botIsMentioned: true,
      datetime: '2026-01-01T00:00:00.000Z',
    });
  });
});
