'use strict';

const assert = require('node:assert/strict');
const { describe, test } = require('node:test');

const { loadWithMocks } = require('./helpers.cjs');

// ---------------------------------------------------------------------------
// searchRecallTool — the v3 §9 / phase 7 shared recall query tool (used by
// both summarize and respond). recall/similarity.js is deliberately NOT
// mocked here — the ranking (semantic + thread-boost + keyword-boost) and
// the chain-merge/dedupe behavior under test are real, not simulated.
// ---------------------------------------------------------------------------

function loadTool(t, overrides = {}) {
  const collaborators = {
    embed: t.mock.fn(async (texts) => [[1, 0]]),
    getPluginRuntime: t.mock.fn(() => ({ id: 'fake-runtime' })),
    readRecallEntries: t.mock.fn(async () => []),
    getSupersedingChain: t.mock.fn(async () => []),
    ...overrides,
  };

  const loaded = loadWithMocks(require.resolve('../processing/search-recall-tool'), {
    [require.resolve('../storage/recall-store')]: {
      readRecallEntries: collaborators.readRecallEntries,
      getSupersedingChain: collaborators.getSupersedingChain,
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

describe('search_recall — validation', () => {
  test('rejects a missing spaceId or query', async (t) => {
    const { searchRecallTool } = loadTool(t);
    const tool = searchRecallTool();

    const result = await tool.execute('call-1', { query: 'anything' });
    assert.equal(result.ok, false);
    assert.match(result.errors[0], /spaceId/);

    const result2 = await tool.execute('call-2', { spaceId: 'space-1', query: '  ' });
    assert.equal(result2.ok, false);
    assert.match(result2.errors[0], /query/);
  });
});

describe('search_recall — ranking (real recall/similarity.js)', () => {
  test('ranks by cosine similarity, closest first', async (t) => {
    const entries = [
      { id: 'recall_far', thread_id: 't1', summary_text: 'far', keywords: [], embedding: [0, 1] },
      { id: 'recall_close', thread_id: 't1', summary_text: 'close', keywords: [], embedding: [1, 0] },
    ];
    const { searchRecallTool } = loadTool(t, {
      embed: t.mock.fn(async () => [[1, 0]]), // query embedding == "close" entry's own embedding
      readRecallEntries: t.mock.fn(async () => entries),
    });
    const tool = searchRecallTool();

    const result = await tool.execute('call-1', { spaceId: 'space-1', query: 'find something' });

    assert.equal(result.ok, true);
    assert.equal(result.results[0].id, 'recall_close');
  });

  test('a same-thread match outranks an otherwise-equal cross-thread match', async (t) => {
    const entries = [
      { id: 'recall_other_thread', thread_id: 't2', summary_text: 'x', keywords: [], embedding: [1, 0] },
      { id: 'recall_same_thread', thread_id: 't1', summary_text: 'x', keywords: [], embedding: [1, 0] },
    ];
    const { searchRecallTool } = loadTool(t, {
      embed: t.mock.fn(async () => [[1, 0]]),
      readRecallEntries: t.mock.fn(async () => entries),
    });
    const tool = searchRecallTool();

    const result = await tool.execute('call-1', {
      spaceId: 'space-1',
      query: 'find something',
      threadId: 't1',
    });

    assert.equal(result.ok, true);
    assert.equal(result.results[0].id, 'recall_same_thread');
  });

  test('cross-thread matches still surface — thread is a boost, not a filter', async (t) => {
    const entries = [
      { id: 'recall_only_cross_thread', thread_id: 't2', summary_text: 'x', keywords: [], embedding: [1, 0] },
    ];
    const { searchRecallTool } = loadTool(t, {
      embed: t.mock.fn(async () => [[1, 0]]),
      readRecallEntries: t.mock.fn(async () => entries),
    });
    const tool = searchRecallTool();

    const result = await tool.execute('call-1', {
      spaceId: 'space-1',
      query: 'find something',
      threadId: 't1',
    });

    assert.equal(result.ok, true);
    assert.equal(result.results.length, 1);
    assert.equal(result.results[0].id, 'recall_only_cross_thread');
  });

  test('a keyword match outranks an otherwise-equal non-matching entry', async (t) => {
    const entries = [
      { id: 'recall_no_keyword', thread_id: 't1', summary_text: 'x', keywords: [], embedding: [1, 0] },
      { id: 'recall_keyword_match', thread_id: 't1', summary_text: 'x', keywords: ['Postgres'], embedding: [1, 0] },
    ];
    const { searchRecallTool } = loadTool(t, {
      embed: t.mock.fn(async () => [[1, 0]]),
      readRecallEntries: t.mock.fn(async () => entries),
    });
    const tool = searchRecallTool();

    const result = await tool.execute('call-1', {
      spaceId: 'space-1',
      query: 'what database, Postgres or MySQL?',
    });

    assert.equal(result.ok, true);
    assert.equal(result.results[0].id, 'recall_keyword_match');
  });
});

describe('search_recall — supersession chains', () => {
  test('returns a matched entry alongside everything that supersedes it', async (t) => {
    const entries = [
      { id: 'recall_head', thread_id: 't1', summary_text: 'original', keywords: [], embedding: [1, 0] },
      { id: 'recall_v2', thread_id: 't1', summary_text: 'updated', keywords: [], embedding: [0, 1] },
    ];
    const { searchRecallTool } = loadTool(t, {
      embed: t.mock.fn(async () => [[1, 0]]),
      readRecallEntries: t.mock.fn(async () => entries),
      getSupersedingChain: t.mock.fn(async (entryId) =>
        entryId === 'recall_head' ? ['recall_v2'] : []
      ),
    });
    const tool = searchRecallTool();

    const result = await tool.execute('call-1', { spaceId: 'space-1', query: 'original decision' });

    assert.equal(result.ok, true);
    const ids = result.results.map((entry) => entry.id);
    assert.ok(ids.includes('recall_head'));
    assert.ok(ids.includes('recall_v2'));
  });

  test('dedupes when two ranked matches share a member further down their chains', async (t) => {
    const entries = [
      { id: 'recall_a', thread_id: 't1', summary_text: 'a', keywords: [], embedding: [1, 0] },
      { id: 'recall_b', thread_id: 't1', summary_text: 'b', keywords: [], embedding: [1, 0] },
      { id: 'recall_shared_head', thread_id: 't1', summary_text: 'head', keywords: [], embedding: [1, 0] },
    ];
    const { searchRecallTool } = loadTool(t, {
      embed: t.mock.fn(async () => [[1, 0]]),
      readRecallEntries: t.mock.fn(async () => entries),
      // Both recall_a and recall_b independently lead to the same head.
      getSupersedingChain: t.mock.fn(async (entryId) => {
        if (entryId === 'recall_a') return ['recall_shared_head'];
        if (entryId === 'recall_b') return ['recall_shared_head'];
        return [];
      }),
    });
    const tool = searchRecallTool();

    const result = await tool.execute('call-1', { spaceId: 'space-1', query: 'anything' });

    assert.equal(result.ok, true);
    const headCount = result.results.filter((entry) => entry.id === 'recall_shared_head').length;
    assert.equal(headCount, 1);
  });
});

describe('search_recall — fails soft', () => {
  test('returns { ok: false } instead of throwing when embed() fails', async (t) => {
    const { searchRecallTool } = loadTool(t, {
      embed: t.mock.fn(async () => {
        throw new Error('memorySearch is not configured for the embeddings agent');
      }),
    });
    const tool = searchRecallTool();

    const result = await tool.execute('call-1', { spaceId: 'space-1', query: 'anything' });

    assert.equal(result.ok, false);
    assert.match(result.errors[0], /memorySearch is not configured/);
  });
});
