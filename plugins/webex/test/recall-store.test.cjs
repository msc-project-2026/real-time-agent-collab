'use strict';

const assert = require('node:assert/strict');
const { describe, test } = require('node:test');

const { makeTempWorkspace } = require('./helpers.cjs');
const {
  appendRecallEntry,
  appendSupersessionRow,
  readRecallEntries,
  getSupersedingChain,
} = require('../storage/recall-store');

// ---------------------------------------------------------------------------
// v3 §9 recall/vector index (phase 7). Covers the write-once entry shape,
// the separate reverse-lookup supersession index (mirrors tasks-store.js's
// task-parents.json pattern), and the transitive chain walk.
// ---------------------------------------------------------------------------

describe('recall-store — appendRecallEntry / readRecallEntries', () => {
  test('appends an entry with the full v3 §9 shape', async (t) => {
    const root = await makeTempWorkspace(t);

    const entry = await appendRecallEntry({
      spaceId: 'space-1',
      explicitRoot: root,
      threadId: 'thread-a',
      summaryText: 'The team decided to use Postgres for the new service.',
      keywords: ['Postgres'],
      messageIds: ['msg-1', 'msg-2'],
      embedding: [0.1, 0.2, 0.3],
    });

    assert.match(entry.id, /^recall_/);
    assert.equal(entry.space_id, 'space-1');
    assert.equal(entry.thread_id, 'thread-a');
    assert.equal(entry.summary_text, 'The team decided to use Postgres for the new service.');
    assert.deepEqual(entry.keywords, ['Postgres']);
    assert.deepEqual(entry.message_ids, ['msg-1', 'msg-2']);
    assert.deepEqual(entry.embedding, [0.1, 0.2, 0.3]);
    assert.ok(entry.created_at);

    const entries = await readRecallEntries({ spaceId: 'space-1', explicitRoot: root });
    assert.equal(entries.length, 1);
    assert.equal(entries[0].id, entry.id);
  });

  test('defaults keywords to an empty array when omitted', async (t) => {
    const root = await makeTempWorkspace(t);

    const entry = await appendRecallEntry({
      spaceId: 'space-1',
      explicitRoot: root,
      threadId: 'thread-a',
      summaryText: 'Some summary.',
      messageIds: ['msg-1'],
      embedding: [0.1],
    });

    assert.deepEqual(entry.keywords, []);
  });

  test('requires threadId, summaryText, messageIds, and embedding', async (t) => {
    const root = await makeTempWorkspace(t);
    const base = {
      spaceId: 'space-1',
      explicitRoot: root,
      threadId: 'thread-a',
      summaryText: 'Some summary.',
      messageIds: ['msg-1'],
      embedding: [0.1],
    };

    await assert.rejects(
      appendRecallEntry({ ...base, threadId: undefined }),
      /threadId is required/
    );
    await assert.rejects(
      appendRecallEntry({ ...base, summaryText: '' }),
      /summaryText is required/
    );
    await assert.rejects(
      appendRecallEntry({ ...base, messageIds: [] }),
      /messageIds must be a non-empty array/
    );
    await assert.rejects(
      appendRecallEntry({ ...base, embedding: [] }),
      /embedding must be a non-empty array/
    );
  });

  test('entries accumulate across multiple appends, one file per space', async (t) => {
    const root = await makeTempWorkspace(t);

    await appendRecallEntry({
      spaceId: 'space-1',
      explicitRoot: root,
      threadId: 'thread-a',
      summaryText: 'First.',
      messageIds: ['msg-1'],
      embedding: [0.1],
    });
    await appendRecallEntry({
      spaceId: 'space-1',
      explicitRoot: root,
      threadId: 'thread-b',
      summaryText: 'Second.',
      messageIds: ['msg-2'],
      embedding: [0.2],
    });

    const entries = await readRecallEntries({ spaceId: 'space-1', explicitRoot: root });
    assert.equal(entries.length, 2);
    assert.deepEqual(entries.map((entry) => entry.thread_id).sort(), ['thread-a', 'thread-b']);
  });

  test('readRecallEntries returns an empty array for a space with no entries yet', async (t) => {
    const root = await makeTempWorkspace(t);

    const entries = await readRecallEntries({ spaceId: 'space-never-written', explicitRoot: root });
    assert.deepEqual(entries, []);
  });
});

describe('recall-store — supersession reverse index', () => {
  test('appendSupersessionRow records an old->new row without mutating the old entry', async (t) => {
    const root = await makeTempWorkspace(t);

    const original = await appendRecallEntry({
      spaceId: 'space-1',
      explicitRoot: root,
      threadId: 'thread-a',
      summaryText: 'Original decision.',
      messageIds: ['msg-1'],
      embedding: [0.1],
    });
    const replacement = await appendRecallEntry({
      spaceId: 'space-1',
      explicitRoot: root,
      threadId: 'thread-a',
      summaryText: 'Updated decision.',
      messageIds: ['msg-2'],
      embedding: [0.2],
    });

    await appendSupersessionRow({ spaceId: 'space-1', explicitRoot: root, oldId: original.id, newId: replacement.id });

    // The original entry itself is never mutated — supersession lives only
    // in the separate reverse index.
    const entries = await readRecallEntries({ spaceId: 'space-1', explicitRoot: root });
    const originalReRead = entries.find((entry) => entry.id === original.id);
    assert.equal('supersedes' in originalReRead, false);
    assert.equal('supersededBy' in originalReRead, false);

    const chain = await getSupersedingChain(original.id, { spaceId: 'space-1', explicitRoot: root });
    assert.deepEqual(chain, [replacement.id]);
  });

  test('getSupersedingChain walks transitively (A -> B -> C)', async (t) => {
    const root = await makeTempWorkspace(t);

    const a = await appendRecallEntry({
      spaceId: 'space-1', explicitRoot: root, threadId: 'thread-a',
      summaryText: 'A', messageIds: ['msg-1'], embedding: [0.1],
    });
    const b = await appendRecallEntry({
      spaceId: 'space-1', explicitRoot: root, threadId: 'thread-a',
      summaryText: 'B', messageIds: ['msg-2'], embedding: [0.2],
    });
    const c = await appendRecallEntry({
      spaceId: 'space-1', explicitRoot: root, threadId: 'thread-a',
      summaryText: 'C', messageIds: ['msg-3'], embedding: [0.3],
    });

    await appendSupersessionRow({ spaceId: 'space-1', explicitRoot: root, oldId: a.id, newId: b.id });
    await appendSupersessionRow({ spaceId: 'space-1', explicitRoot: root, oldId: b.id, newId: c.id });

    const chain = await getSupersedingChain(a.id, { spaceId: 'space-1', explicitRoot: root });
    assert.deepEqual(chain.sort(), [b.id, c.id].sort());
  });

  test('an entry with no superseding row has an empty chain', async (t) => {
    const root = await makeTempWorkspace(t);

    const entry = await appendRecallEntry({
      spaceId: 'space-1', explicitRoot: root, threadId: 'thread-a',
      summaryText: 'Standalone.', messageIds: ['msg-1'], embedding: [0.1],
    });

    const chain = await getSupersedingChain(entry.id, { spaceId: 'space-1', explicitRoot: root });
    assert.deepEqual(chain, []);
  });
});
