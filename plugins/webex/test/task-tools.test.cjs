'use strict';

const assert = require('node:assert/strict');
const { describe, test } = require('node:test');

const { loadWithMocks } = require('./helpers.cjs');

// ---------------------------------------------------------------------------
// Category: write_task / search_tasks tool validation and delegation.
// Unlike tag_message (in-memory pending-result map), these tools write
// straight through to context/tasks-store.js — mirrors the existing
// tools/load-processing-batch.js test pattern (mock the underlying store
// call, assert on validation + delegation), rather than hitting real
// storage; tasks-store.js's own correctness is covered directly in
// tasks-store.test.cjs.
// ---------------------------------------------------------------------------

describe('write_task tool', () => {
  function loadTool(t, overrides = {}) {
    const upsertTask =
      overrides.upsertTask ?? t.mock.fn(async () => ({ id: 'task_abc', type: 'development' }));
    const loaded = loadWithMocks(require.resolve('../processing/write-task-tool'), {
      [require.resolve('../context/tasks-store')]: { upsertTask },
    });
    t.after(loaded.restore);
    return { ...loaded.subject, upsertTask };
  }

  test('creating a task delegates to upsertTask with the given fields', async (t) => {
    const { writeTaskTool, upsertTask } = loadTool(t);
    const tool = writeTaskTool();

    const result = await tool.execute('id-1', {
      spaceId: 'space-1',
      type: 'development',
      assigned: 'alice',
      message_ids: ['msg-1'],
    });

    assert.equal(result.ok, true);
    assert.equal(upsertTask.mock.callCount(), 1);
    assert.deepEqual(upsertTask.mock.calls[0].arguments[0], {
      spaceId: 'space-1',
      id: undefined,
      patch: {
        type: 'development',
        assigned: 'alice',
        deadline: undefined,
        status: undefined,
        message_ids: ['msg-1'],
        child_tasks: undefined,
      },
    });
  });

  test('patching passes the given id through', async (t) => {
    const { writeTaskTool, upsertTask } = loadTool(t);
    const tool = writeTaskTool();

    await tool.execute('id-1', { spaceId: 'space-1', id: 'task_abc', status: 'done' });

    assert.equal(upsertTask.mock.calls[0].arguments[0].id, 'task_abc');
    assert.equal(upsertTask.mock.calls[0].arguments[0].patch.status, 'done');
  });

  test('missing spaceId returns a validation error and never calls the store', async (t) => {
    const { writeTaskTool, upsertTask } = loadTool(t);
    const tool = writeTaskTool();

    const result = await tool.execute('id-1', { type: 'development' });

    assert.equal(result.ok, false);
    assert.ok(result.errors.some((e) => e.includes('spaceId')));
    assert.equal(upsertTask.mock.callCount(), 0);
  });

  test('creating without type or id returns a validation error', async (t) => {
    const { writeTaskTool, upsertTask } = loadTool(t);
    const tool = writeTaskTool();

    const result = await tool.execute('id-1', { spaceId: 'space-1' });

    assert.equal(result.ok, false);
    assert.ok(result.errors.some((e) => e.includes('type')));
    assert.equal(upsertTask.mock.callCount(), 0);
  });

  test('an unrecognised type is rejected', async (t) => {
    const { writeTaskTool } = loadTool(t);
    const tool = writeTaskTool();

    const result = await tool.execute('id-1', { spaceId: 'space-1', type: 'not-a-real-type' });

    assert.equal(result.ok, false);
    assert.ok(result.errors.some((e) => e.includes('type')));
  });

  test('an unrecognised status is rejected', async (t) => {
    const { writeTaskTool } = loadTool(t);
    const tool = writeTaskTool();

    const result = await tool.execute('id-1', {
      spaceId: 'space-1',
      type: 'development',
      status: 'not-a-real-status',
    });

    assert.equal(result.ok, false);
    assert.ok(result.errors.some((e) => e.includes('status')));
  });

  test('non-array message_ids/child_tasks are rejected', async (t) => {
    const { writeTaskTool } = loadTool(t);
    const tool = writeTaskTool();

    const result = await tool.execute('id-1', {
      spaceId: 'space-1',
      type: 'development',
      message_ids: 'msg-1',
      child_tasks: 'task_2',
    });

    assert.equal(result.ok, false);
    assert.ok(result.errors.some((e) => e.includes('message_ids')));
    assert.ok(result.errors.some((e) => e.includes('child_tasks')));
  });

  test('a store rejection (e.g. cycle) surfaces as ok:false, not a throw', async (t) => {
    const { writeTaskTool } = loadTool(t, {
      upsertTask: t.mock.fn(async () => {
        throw new Error('child_tasks write rejected: would create a cycle');
      }),
    });
    const tool = writeTaskTool();

    const result = await tool.execute('id-1', {
      spaceId: 'space-1',
      id: 'task_a',
      child_tasks: ['task_b'],
    });

    assert.equal(result.ok, false);
    assert.ok(result.errors.some((e) => e.includes('cycle')));
  });
});

describe('search_tasks tool', () => {
  function loadTool(t, overrides = {}) {
    const searchTasks =
      overrides.searchTasks ??
      t.mock.fn(async () => [{ id: 'task_abc', type: 'development' }]);
    const loaded = loadWithMocks(require.resolve('../processing/search-tasks-tool'), {
      [require.resolve('../context/tasks-store')]: { searchTasks },
    });
    t.after(loaded.restore);
    return { ...loaded.subject, searchTasks };
  }

  test('delegates to searchTasks and defaults includeArchived to true', async (t) => {
    const { searchTasksTool, searchTasks } = loadTool(t);
    const tool = searchTasksTool();

    const result = await tool.execute('id-1', { spaceId: 'space-1', query: 'alice' });

    assert.equal(result.ok, true);
    assert.deepEqual(result.tasks, [{ id: 'task_abc', type: 'development' }]);
    assert.deepEqual(searchTasks.mock.calls[0].arguments[0], {
      spaceId: 'space-1',
      query: 'alice',
      includeArchived: true,
    });
  });

  test('includeArchived: false is passed through', async (t) => {
    const { searchTasksTool, searchTasks } = loadTool(t);
    const tool = searchTasksTool();

    await tool.execute('id-1', { spaceId: 'space-1', query: 'alice', includeArchived: false });

    assert.equal(searchTasks.mock.calls[0].arguments[0].includeArchived, false);
  });

  test('missing query returns a validation error and never calls the store', async (t) => {
    const { searchTasksTool, searchTasks } = loadTool(t);
    const tool = searchTasksTool();

    const result = await tool.execute('id-1', { spaceId: 'space-1', query: '   ' });

    assert.equal(result.ok, false);
    assert.ok(result.errors.some((e) => e.includes('query')));
    assert.equal(searchTasks.mock.callCount(), 0);
  });

  test('missing spaceId returns a validation error', async (t) => {
    const { searchTasksTool } = loadTool(t);
    const tool = searchTasksTool();

    const result = await tool.execute('id-1', { query: 'alice' });

    assert.equal(result.ok, false);
    assert.ok(result.errors.some((e) => e.includes('spaceId')));
  });
});
