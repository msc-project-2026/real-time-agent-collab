'use strict';

const assert = require('node:assert/strict');
const { describe, test } = require('node:test');

const { loadWithMocks } = require('./helpers.cjs');

// ---------------------------------------------------------------------------
// Category: write_summary tool validation and delegation (v3 §9, phase 7).
// Mirrors test/task-tools.test.cjs's write_task coverage: mock the
// underlying storage/embeddings calls, assert on validation + delegation,
// rather than hitting real storage or a real embeddings HTTP call —
// recall-store.js's own correctness is covered directly in
// recall-store.test.cjs, and embeddings/client.js is a thin HTTP wrapper not
// worth mocking-through here.
// ---------------------------------------------------------------------------

describe('write_summary tool', () => {
  function loadTool(t, overrides = {}) {
    const collaborators = {
      appendRecallEntry: t.mock.fn(async () => ({ id: 'recall_abc', thread_id: '__main__' })),
      appendSupersessionRow: t.mock.fn(async () => undefined),
      embed: t.mock.fn(async () => [[0.1, 0.2, 0.3]]),
      getPluginRuntime: t.mock.fn(() => ({ id: 'fake-runtime' })),
      ...overrides,
    };

    const loaded = loadWithMocks(require.resolve('../processing/summarize/tool'), {
      [require.resolve('../storage/recall-store')]: {
        appendRecallEntry: collaborators.appendRecallEntry,
        appendSupersessionRow: collaborators.appendSupersessionRow,
      },
      [require.resolve('../embeddings/client')]: {
        embed: collaborators.embed,
      },
      [require.resolve('../runtime')]: {
        getPluginRuntime: collaborators.getPluginRuntime,
      },
    });
    t.after(loaded.restore);

    return { ...loaded.subject, collaborators };
  }

  test('embeds summaryText and delegates to appendRecallEntry with the given fields', async (t) => {
    const { writeSummaryTool, collaborators } = loadTool(t);
    const tool = writeSummaryTool();

    const result = await tool.execute('id-1', {
      spaceId: 'space-1',
      threadId: '__main__',
      summaryText: 'The team picked Postgres.',
      keywords: ['Postgres'],
      messageIds: ['msg-1', 'msg-2'],
    });

    assert.equal(result.ok, true);
    assert.equal(collaborators.embed.mock.callCount(), 1);
    assert.deepEqual(collaborators.embed.mock.calls[0].arguments[0], ['The team picked Postgres.']);

    assert.equal(collaborators.appendRecallEntry.mock.callCount(), 1);
    assert.deepEqual(collaborators.appendRecallEntry.mock.calls[0].arguments[0], {
      spaceId: 'space-1',
      threadId: '__main__',
      summaryText: 'The team picked Postgres.',
      keywords: ['Postgres'],
      messageIds: ['msg-1', 'msg-2'],
      embedding: [0.1, 0.2, 0.3],
    });
    assert.equal(collaborators.appendSupersessionRow.mock.callCount(), 0);
  });

  test('supersedes ids each produce a separate appendSupersessionRow call against the new entry', async (t) => {
    const { writeSummaryTool, collaborators } = loadTool(t);
    const tool = writeSummaryTool();

    await tool.execute('id-1', {
      spaceId: 'space-1',
      threadId: '__main__',
      summaryText: 'Updated decision.',
      messageIds: ['msg-3'],
      supersedes: ['recall_old_1', 'recall_old_2'],
    });

    assert.equal(collaborators.appendSupersessionRow.mock.callCount(), 2);
    assert.deepEqual(collaborators.appendSupersessionRow.mock.calls[0].arguments[0], {
      spaceId: 'space-1',
      oldId: 'recall_old_1',
      newId: 'recall_abc',
    });
    assert.deepEqual(collaborators.appendSupersessionRow.mock.calls[1].arguments[0], {
      spaceId: 'space-1',
      oldId: 'recall_old_2',
      newId: 'recall_abc',
    });
  });

  test('missing spaceId returns a validation error and never calls embed or the store', async (t) => {
    const { writeSummaryTool, collaborators } = loadTool(t);
    const tool = writeSummaryTool();

    const result = await tool.execute('id-1', {
      threadId: '__main__',
      summaryText: 'Something.',
      messageIds: ['msg-1'],
    });

    assert.equal(result.ok, false);
    assert.ok(result.errors.some((e) => e.includes('spaceId')));
    assert.equal(collaborators.embed.mock.callCount(), 0);
    assert.equal(collaborators.appendRecallEntry.mock.callCount(), 0);
  });

  test('missing threadId returns a validation error', async (t) => {
    const { writeSummaryTool } = loadTool(t);
    const tool = writeSummaryTool();

    const result = await tool.execute('id-1', {
      spaceId: 'space-1',
      summaryText: 'Something.',
      messageIds: ['msg-1'],
    });

    assert.equal(result.ok, false);
    assert.ok(result.errors.some((e) => e.includes('threadId')));
  });

  test('missing or empty summaryText returns a validation error', async (t) => {
    const { writeSummaryTool } = loadTool(t);
    const tool = writeSummaryTool();

    const result = await tool.execute('id-1', {
      spaceId: 'space-1',
      threadId: '__main__',
      summaryText: '   ',
      messageIds: ['msg-1'],
    });

    assert.equal(result.ok, false);
    assert.ok(result.errors.some((e) => e.includes('summaryText')));
  });

  test('missing messageIds returns a validation error', async (t) => {
    const { writeSummaryTool } = loadTool(t);
    const tool = writeSummaryTool();

    const result = await tool.execute('id-1', {
      spaceId: 'space-1',
      threadId: '__main__',
      summaryText: 'Something.',
      messageIds: [],
    });

    assert.equal(result.ok, false);
    assert.ok(result.errors.some((e) => e.includes('messageIds')));
  });

  test('fails soft — an embed() error returns { ok: false } instead of throwing', async (t) => {
    const { writeSummaryTool } = loadTool(t, {
      embed: async () => {
        throw new Error('memorySearch is not configured for the embeddings agent');
      },
    });
    const tool = writeSummaryTool();

    const result = await tool.execute('id-1', {
      spaceId: 'space-1',
      threadId: '__main__',
      summaryText: 'Something.',
      messageIds: ['msg-1'],
    });

    assert.equal(result.ok, false);
    assert.match(result.errors[0], /memorySearch is not configured/);
  });
});
