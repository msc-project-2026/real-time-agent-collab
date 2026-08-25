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
// These tests verify persisted context (v3 §7c tasks, threads) is converted
// into the public summary shape, including every status count and safe
// defaults for optional fields.
describe('collaboration visibility summary', () => {
  test('counts and formats tasks and threads', async (t) => {
    const getTasks = t.mock.fn(async () => [
      { id: 'task-1', title: 'Fix login', type: 'development', status: 'unapproved' },
      { id: 'task-2', title: 'Design review', type: 'design', status: 'backlog' },
      { id: 'task-3', title: 'Handoff', type: 'coordination', status: 'in_progress' },
      { id: 'task-3b', title: 'Polish', type: 'design', status: 'in_review' },
      { id: 'task-4', title: 'Ship it', type: 'development', status: 'done' },
      { id: 'task-5', title: 'Old idea', type: 'research', status: 'archived' },
    ]);
    const getThreads = t.mock.fn(async () => [
      {
        key: 'root-1',
        kind: 'webex_thread',
        rootMessageId: 'root-1',
        pending: [{ id: 'message-1' }],
        processing: [{ id: 'message-2' }],
        processed: [{ id: 'message-3' }, { id: 'message-4' }],
        updatedAt: '2026-08-02T00:00:00.000Z',
      },
      { key: '__main__', kind: 'main', pending: null, processing: null, processed: null },
    ]);
    const loaded = loadWithMocks(require.resolve('../visibility/summary'), {
      [require.resolve('../storage/tasks-store')]: { getTasks },
      [require.resolve('../storage/threads-store')]: { getThreads },
    });
    t.after(loaded.restore);

    const summary = await loaded.subject.buildContextSummary({ spaceId: 'space-1' });

    assert.equal(summary.spaceId, 'space-1');
    assert.match(summary.generatedAt, /^\d{4}-\d{2}-\d{2}T/);
    assert.deepEqual(summary.counts, {
      unapprovedTasks: 1,
      backlogTasks: 1,
      inProgressTasks: 1,
      inReviewTasks: 1,
      doneTasks: 1,
      archivedTasks: 1,
    });
    assert.deepEqual(summary.tasks[0], {
      id: 'task-1',
      title: 'Fix login',
      description: undefined,
      type: 'development',
      status: 'unapproved',
      assigned: null,
      deadline: null,
      message_ids: [],
      child_tasks: [],
      createdAt: null,
      updatedAt: null,
    });
    assert.equal(summary.threads[0].pendingCount, 1);
    assert.equal(summary.threads[0].processingCount, 1);
    assert.equal(summary.threads[0].processedCount, 2);
    assert.equal(summary.threads[1].pendingCount, 0);
    assert.equal(summary.threads[1].processingCount, 0);
    assert.equal(summary.threads[1].processedCount, 0);
    assert.equal(summary.threads[1].rootMessageId, null);
    assert.deepEqual(getTasks.mock.calls[0].arguments[0], {
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

function loadSpaceRouter(t) {
  const collaborators = {
    buildContextSummary: t.mock.fn(async ({ spaceId }) => ({ spaceId, counts: {} })),
    getTasks: t.mock.fn(async () => [{ id: 'task-1' }]),
    getThreads: t.mock.fn(async () => [{ key: '__main__' }]),
    getSpaceMembers: t.mock.fn(async () => [{ id: 'alice@example.com', name: 'Alice' }]),
  };
  const loaded = loadWithMocks(require.resolve('../visibility/space-router'), {
    [require.resolve('../visibility/summary')]: {
      buildContextSummary: collaborators.buildContextSummary,
    },
    [require.resolve('../storage/tasks-store')]: { getTasks: collaborators.getTasks },
    [require.resolve('../storage/threads-store')]: {
      getThreads: collaborators.getThreads,
    },
    [require.resolve('../config/members')]: {
      getSpaceMembers: collaborators.getSpaceMembers,
    },
  });
  t.after(loaded.restore);
  return { ...loaded.subject, collaborators };
}

// Category: Collaboration visibility HTTP API.
// These tests verify route ownership, method protection, decoded space IDs, query
// contracts, and response envelopes for every exposed space resource.
describe('collaboration visibility HTTP API', () => {
  test('declines unrelated paths without writing a response', async (t) => {
    const { spaceRouter, collaborators } = loadSpaceRouter(t);
    const response = makeResponse(t);

    assert.equal(
      await spaceRouter({ method: 'GET', url: '/webex/collab/unknown' }, response),
      false
    );
    assert.equal(response.end.mock.callCount(), 0);
    assert.equal(collaborators.getTasks.mock.callCount(), 0);
  });

  test('returns 405 for a matched non-GET request', async (t) => {
    const { spaceRouter, collaborators } = loadSpaceRouter(t);
    const response = makeResponse(t);

    assert.equal(
      await spaceRouter(
        { method: 'POST', url: '/webex/collab/spaces/space-1/tasks' },
        response
      ),
      true
    );
    assert.equal(response.statusCode, 405);
    assert.equal(response.headers.Allow, 'GET');
    assert.equal(response.body, 'Method Not Allowed');
    assert.equal(collaborators.getTasks.mock.callCount(), 0);
  });

  test('serves summary and decodes the space identifier', async (t) => {
    const { spaceRouter, collaborators } = loadSpaceRouter(t);
    const response = makeResponse(t);

    assert.equal(
      await spaceRouter(
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

  test('serves tasks, threads, and members with bounded queries', async (t) => {
    const { spaceRouter, collaborators } = loadSpaceRouter(t);
    const cases = [
      ['tasks', collaborators.getTasks, { spaceId: 'space-1', limit: 200 }],
      ['threads', collaborators.getThreads, { spaceId: 'space-1', limit: 100 }],
      ['members', collaborators.getSpaceMembers, { spaceId: 'space-1' }],
    ];

    for (const [resource, collaborator, expectedQuery] of cases) {
      const response = makeResponse(t);
      assert.equal(
        await spaceRouter(
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

  test('the retired /conversations and /items routes no longer match', async (t) => {
    const { spaceRouter, collaborators } = loadSpaceRouter(t);

    for (const resource of ['conversations', 'items']) {
      const response = makeResponse(t);
      assert.equal(
        await spaceRouter(
          { method: 'GET', url: `/webex/collab/spaces/space-1/${resource}` },
          response
        ),
        false
      );
    }
    assert.equal(collaborators.getTasks.mock.callCount(), 0);
    assert.equal(collaborators.getThreads.mock.callCount(), 0);
  });
});
