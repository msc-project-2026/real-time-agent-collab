'use strict';

const assert = require('node:assert/strict');
const { describe, test } = require('node:test');

const { loadWithMocks } = require('./helpers.cjs');

function makeResponse(t) {
  const response = {
    statusCode: null,
    headers: {},
    body: undefined,
  };
  response.setHeader = t.mock.fn((name, value) => {
    response.headers[name] = value;
  });
  response.end = t.mock.fn((body) => {
    response.body = body;
  });
  return response;
}

function jsonBody(response) {
  return JSON.parse(String(response.body));
}

// Category: Collaboration visibility summary.
// These tests verify persisted context is converted into the public summary shape,
// including every status/type count and safe defaults for optional fields.
describe('collaboration visibility summary', () => {
  test('counts and formats conversations, items, and threads', async (t) => {
    const getConversations = t.mock.fn(async () => [
      {
        id: 'conv-active',
        topic: 'Release',
        summary: 'Release work',
        status: 'active',
        threadRootIds: ['root-1'],
        lastMessageIds: ['message-1'],
        startedAt: '2026-08-01T00:00:00.000Z',
        updatedAt: '2026-08-02T00:00:00.000Z',
      },
      { id: 'conv-dormant', topic: 'Old work', summary: '', status: 'dormant' },
    ]);
    const getItems = t.mock.fn(async () => [
      { id: 'task', type: 'task', status: 'open', title: 'Task' },
      { id: 'issue', type: 'issue', status: 'in_progress', title: 'Issue' },
      { id: 'risk', type: 'risk', status: 'blocked', title: 'Risk' },
      { id: 'decision', type: 'decision', status: 'resolved', title: 'Decision' },
      { id: 'question', type: 'question', status: 'open', title: 'Question' },
    ]);
    const getThreads = t.mock.fn(async () => [
      {
        key: 'root-1',
        kind: 'webex_thread',
        rootMessageId: 'root-1',
        contextWindow: [{ id: 'message-1' }, { id: 'message-2' }],
        updatedAt: '2026-08-02T00:00:00.000Z',
      },
      { key: '__main__', kind: 'main', contextWindow: null },
    ]);
    const loaded = loadWithMocks(require.resolve('../visibility/summary'), {
      [require.resolve('../context/conversations-store')]: { getConversations },
      [require.resolve('../context/items-store')]: { getItems },
      [require.resolve('../context/threads-store')]: { getThreads },
    });
    t.after(loaded.restore);

    const summary = await loaded.subject.buildContextSummary({ spaceId: 'space-1' });

    assert.equal(summary.spaceId, 'space-1');
    assert.match(summary.generatedAt, /^\d{4}-\d{2}-\d{2}T/);
    assert.deepEqual(summary.counts, {
      activeConversations: 1,
      dormantConversations: 1,
      openItems: 2,
      inProgressItems: 1,
      blockedItems: 1,
      resolvedItems: 1,
      risks: 1,
      decisions: 1,
      questions: 1,
      tasks: 1,
      issues: 1,
    });
    assert.deepEqual(summary.conversations[1], {
      id: 'conv-dormant',
      topic: 'Old work',
      summary: '',
      status: 'dormant',
      threadRootIds: [],
      lastMessageIds: [],
      startedAt: null,
      updatedAt: null,
    });
    assert.deepEqual(summary.items[0], {
      id: 'task',
      type: 'task',
      status: 'open',
      title: 'Task',
      description: undefined,
      owner: null,
      conversationIds: [],
      evidenceMessageIds: [],
      createdAt: null,
      updatedAt: null,
    });
    assert.equal(summary.threads[0].contextWindowSize, 2);
    assert.equal(summary.threads[1].contextWindowSize, 0);
    assert.equal(summary.threads[1].rootMessageId, null);
    assert.deepEqual(getConversations.mock.calls[0].arguments[0], {
      spaceId: 'space-1',
      statuses: ['active', 'dormant'],
      limit: 100,
    });
    assert.deepEqual(getItems.mock.calls[0].arguments[0], {
      spaceId: 'space-1',
      limit: 200,
    });
    assert.deepEqual(getThreads.mock.calls[0].arguments[0], {
      spaceId: 'space-1',
      limit: 100,
    });
  });

  test('requires a space identifier before querying storage', async () => {
    const { buildContextSummary } = require('../visibility/summary');
    await assert.rejects(buildContextSummary({}), /spaceId is required/);
  });
});

function loadContextRouter(t) {
  const collaborators = {
    buildContextSummary: t.mock.fn(async ({ spaceId }) => ({ spaceId, counts: {} })),
    getConversations: t.mock.fn(async () => [{ id: 'conv-1' }]),
    getItems: t.mock.fn(async () => [{ id: 'item-1' }]),
    getThreads: t.mock.fn(async () => [{ key: '__main__' }]),
  };
  const loaded = loadWithMocks(require.resolve('../visibility/context-router'), {
    [require.resolve('../visibility/summary')]: {
      buildContextSummary: collaborators.buildContextSummary,
    },
    [require.resolve('../context/conversations-store')]: {
      getConversations: collaborators.getConversations,
    },
    [require.resolve('../context/items-store')]: { getItems: collaborators.getItems },
    [require.resolve('../context/threads-store')]: {
      getThreads: collaborators.getThreads,
    },
  });
  t.after(loaded.restore);
  return { ...loaded.subject, collaborators };
}

// Category: Collaboration visibility HTTP API.
// These tests verify route ownership, method protection, decoded space IDs, query
// contracts, and response envelopes for every exposed context resource.
describe('collaboration visibility HTTP API', () => {
  test('declines unrelated paths without writing a response', async (t) => {
    const { contextRouter, collaborators } = loadContextRouter(t);
    const response = makeResponse(t);

    assert.equal(
      await contextRouter({ method: 'GET', url: '/webex/collab/unknown' }, response),
      false
    );
    assert.equal(response.end.mock.callCount(), 0);
    assert.equal(collaborators.getItems.mock.callCount(), 0);
  });

  test('returns 405 for a matched non-GET request', async (t) => {
    const { contextRouter, collaborators } = loadContextRouter(t);
    const response = makeResponse(t);

    assert.equal(
      await contextRouter(
        { method: 'POST', url: '/webex/collab/spaces/space-1/items' },
        response
      ),
      true
    );
    assert.equal(response.statusCode, 405);
    assert.equal(response.headers.Allow, 'GET');
    assert.equal(response.body, 'Method Not Allowed');
    assert.equal(collaborators.getItems.mock.callCount(), 0);
  });

  test('serves summary and decodes the space identifier', async (t) => {
    const { contextRouter, collaborators } = loadContextRouter(t);
    const response = makeResponse(t);

    assert.equal(
      await contextRouter(
        { method: 'GET', url: '/webex/collab/spaces/room%2Fone/summary?x=1' },
        response
      ),
      true
    );
    assert.deepEqual(collaborators.buildContextSummary.mock.calls[0].arguments[0], {
      spaceId: 'room/one',
    });
    assert.equal(response.statusCode, 200);
    assert.equal(response.headers['Content-Type'], 'application/json');
    assert.deepEqual(jsonBody(response), {
      ok: true,
      summary: { spaceId: 'room/one', counts: {} },
    });
  });

  test('serves conversations, items, and threads with bounded queries', async (t) => {
    const { contextRouter, collaborators } = loadContextRouter(t);
    const cases = [
      ['conversations', collaborators.getConversations, {
        spaceId: 'space-1',
        statuses: ['active', 'dormant'],
        limit: 100,
      }],
      ['items', collaborators.getItems, { spaceId: 'space-1', limit: 200 }],
      ['threads', collaborators.getThreads, { spaceId: 'space-1', limit: 100 }],
    ];

    for (const [resource, collaborator, expectedQuery] of cases) {
      const response = makeResponse(t);
      assert.equal(
        await contextRouter(
          { method: 'GET', url: `/webex/collab/spaces/space-1/${resource}` },
          response
        ),
        true
      );
      assert.deepEqual(collaborator.mock.calls.at(-1).arguments[0], expectedQuery);
      assert.equal(jsonBody(response).spaceId, 'space-1');
      assert.ok(Array.isArray(jsonBody(response)[resource]));
    }
  });
});
