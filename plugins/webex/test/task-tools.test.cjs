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
    const readTasksState =
      overrides.readTasksState ?? t.mock.fn(async () => ({ tasks: [] }));
    const readActiveConfig = overrides.readActiveConfig ?? t.mock.fn(async () => null);
    const loaded = loadWithMocks(require.resolve('../processing/extract/tool'), {
      [require.resolve('../storage/tasks-store')]: {
        upsertTask,
        readTasksState,
        CONFIDENCE_AUTO_APPROVE_THRESHOLD: 0.7,
      },
      [require.resolve('../config/store')]: { readActiveConfig },
    });
    t.after(loaded.restore);
    return { ...loaded.subject, upsertTask, readTasksState, readActiveConfig };
  }

  test('creating a task delegates to upsertTask with the given fields', async (t) => {
    const { writeTaskTool, upsertTask } = loadTool(t);
    const tool = writeTaskTool();

    const result = await tool.execute('id-1', {
      spaceId: 'space-1',
      title: 'Fix login test',
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
        title: 'Fix login test',
        description: undefined,
        type: 'development',
        assigned: 'alice',
        deadline: undefined,
        // No status given and not self-assigned to the agent: defaults to
        // 'backlog' on create — a human-assigned task needs no approval step.
        status: 'backlog',
        confidence: undefined,
        message_ids: ['msg-1'],
        child_tasks: undefined,
      },
    });
  });

  test('creating a self-assigned (agent) task with no explicit status leaves status unset, not backlog', async (t) => {
    const { writeTaskTool, upsertTask } = loadTool(t);
    const tool = writeTaskTool();

    await tool.execute('id-1', {
      spaceId: 'space-1',
      title: 'Pick up small fix',
      type: 'development',
      assigned: 'agent',
      confidence: 0.5,
    });

    // Left undefined so upsertTask's own default ('unapproved') applies —
    // that's what the confidence auto-approval override depends on.
    assert.equal(upsertTask.mock.calls[0].arguments[0].patch.status, undefined);
  });

  test('an explicit status from the model is passed through unchanged, even on create', async (t) => {
    const { writeTaskTool, upsertTask } = loadTool(t);
    const tool = writeTaskTool();

    await tool.execute('id-1', {
      spaceId: 'space-1',
      title: 'Already-started work',
      type: 'development',
      assigned: 'alice',
      status: 'in_progress',
    });

    assert.equal(upsertTask.mock.calls[0].arguments[0].patch.status, 'in_progress');
  });

  test('patching an existing human-assigned task with no status leaves it unset (no forced backlog)', async (t) => {
    const { writeTaskTool, upsertTask } = loadTool(t);
    const tool = writeTaskTool();

    await tool.execute('id-1', { spaceId: 'space-1', id: 'task_abc', assigned: 'alice' });

    assert.equal(upsertTask.mock.calls[0].arguments[0].patch.status, undefined);
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

    const result = await tool.execute('id-1', { title: 'Fix login test', type: 'development' });

    assert.equal(result.ok, false);
    assert.ok(result.errors.some((e) => e.includes('spaceId')));
    assert.equal(upsertTask.mock.callCount(), 0);
  });

  test('creating without title or id returns a validation error', async (t) => {
    const { writeTaskTool, upsertTask } = loadTool(t);
    const tool = writeTaskTool();

    const result = await tool.execute('id-1', { spaceId: 'space-1', type: 'development' });

    assert.equal(result.ok, false);
    assert.ok(result.errors.some((e) => e.includes('title')));
    assert.equal(upsertTask.mock.callCount(), 0);
  });

  test('creating without type or id returns a validation error', async (t) => {
    const { writeTaskTool, upsertTask } = loadTool(t);
    const tool = writeTaskTool();

    const result = await tool.execute('id-1', { spaceId: 'space-1', title: 'Fix login test' });

    assert.equal(result.ok, false);
    assert.ok(result.errors.some((e) => e.includes('type')));
    assert.equal(upsertTask.mock.callCount(), 0);
  });

  test('an unrecognised type is rejected', async (t) => {
    const { writeTaskTool } = loadTool(t);
    const tool = writeTaskTool();

    const result = await tool.execute('id-1', {
      spaceId: 'space-1',
      title: 'Fix login test',
      type: 'not-a-real-type',
    });

    assert.equal(result.ok, false);
    assert.ok(result.errors.some((e) => e.includes('type')));
  });

  test('an unrecognised status is rejected', async (t) => {
    const { writeTaskTool } = loadTool(t);
    const tool = writeTaskTool();

    const result = await tool.execute('id-1', {
      spaceId: 'space-1',
      title: 'Fix login test',
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
      title: 'Fix login test',
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
    // execute() has no threaded log (writeTaskTool() is instantiated once
    // at plugin registration, not per spawn — no flowId/log to close over),
    // so a rejection that would otherwise be completely invisible logs via
    // console.warn instead, reaching the same aggregation as everything else.
    const warnSpy = t.mock.method(console, 'warn', () => {});

    const result = await tool.execute('id-1', {
      spaceId: 'space-1',
      id: 'task_a',
      child_tasks: ['task_b'],
    });

    assert.equal(result.ok, false);
    assert.ok(result.errors.some((e) => e.includes('cycle')));
    assert.equal(warnSpy.mock.callCount(), 1);
    assert.match(warnSpy.mock.calls[0].arguments[0], /rejected: threw during write/);
    assert.match(warnSpy.mock.calls[0].arguments[0], /cycle/);
  });

  test('coordination is no longer an accepted type', async (t) => {
    const { writeTaskTool } = loadTool(t);
    const tool = writeTaskTool();

    const result = await tool.execute('id-1', {
      spaceId: 'space-1',
      title: 'Fix login test',
      type: 'coordination',
    });

    assert.equal(result.ok, false);
    assert.ok(result.errors.some((e) => e.includes('type')));
  });

  test('confidence outside 0-1 or non-numeric is rejected, and never calls the store', async (t) => {
    const { writeTaskTool, upsertTask } = loadTool(t);
    const tool = writeTaskTool();
    const warnSpy = t.mock.method(console, 'warn', () => {});

    const tooHigh = await tool.execute('id-1', {
      spaceId: 'space-1',
      title: 'Fix login test',
      type: 'development',
      confidence: 1.5,
    });
    const notNumber = await tool.execute('id-1', {
      spaceId: 'space-1',
      title: 'Fix login test',
      type: 'development',
      confidence: 'high',
    });

    assert.equal(tooHigh.ok, false);
    assert.ok(tooHigh.errors.some((e) => e.includes('confidence')));
    assert.equal(notNumber.ok, false);
    assert.ok(notNumber.errors.some((e) => e.includes('confidence')));
    assert.equal(upsertTask.mock.callCount(), 0);
    // One rejected call logged, one per attempt — a validation rejection
    // previously left no trace anywhere for us to diagnose after the fact.
    assert.equal(warnSpy.mock.callCount(), 2);
    assert.match(warnSpy.mock.calls[0].arguments[0], /rejected: invalid parameters/);
  });

  test('auto-approves and delegates a self-assigned task that clears the confidence threshold on create', async (t) => {
    const upsertTask = t.mock.fn(async (params) => {
      if (params.patch?.status === 'in_progress') {
        return {
          id: 'task_abc',
          type: 'development',
          assigned: 'agent',
          confidence: 0.9,
          status: 'in_progress',
          delegation: params.patch.delegation,
        };
      }
      return {
        id: 'task_abc',
        type: 'development',
        assigned: 'agent',
        confidence: 0.9,
        status: 'unapproved',
      };
    });
    const { writeTaskTool } = loadTool(t, { upsertTask });
    const tool = writeTaskTool();

    const result = await tool.execute('id-1', {
      spaceId: 'space-1',
      title: 'Investigate flaky test',
      type: 'development',
      assigned: 'agent',
      confidence: 0.9,
    });

    assert.equal(result.ok, true);
    assert.equal(upsertTask.mock.callCount(), 2);
    const overridePatch = upsertTask.mock.calls[1].arguments[0].patch;
    assert.equal(overridePatch.status, 'in_progress');
    assert.equal(overridePatch.delegation.target, 'dev-swarm');
    assert.ok(overridePatch.delegation.delegatedAt);
    assert.equal(result.task.status, 'in_progress');
  });

  test('does not auto-approve when confidence is below the threshold', async (t) => {
    const upsertTask = t.mock.fn(async () => ({
      id: 'task_abc',
      type: 'development',
      assigned: 'agent',
      confidence: 0.4,
      status: 'unapproved',
    }));
    const { writeTaskTool } = loadTool(t, { upsertTask });
    const tool = writeTaskTool();

    await tool.execute('id-1', {
      spaceId: 'space-1',
      title: 'Investigate flaky test',
      type: 'development',
      assigned: 'agent',
      confidence: 0.4,
    });

    assert.equal(upsertTask.mock.callCount(), 1);
  });

  test('does not auto-approve a task not assigned to the agent, even with high confidence', async (t) => {
    const upsertTask = t.mock.fn(async () => ({
      id: 'task_abc',
      type: 'development',
      assigned: 'alice',
      confidence: 0.95,
      status: 'unapproved',
    }));
    const { writeTaskTool } = loadTool(t, { upsertTask });
    const tool = writeTaskTool();

    await tool.execute('id-1', {
      spaceId: 'space-1',
      title: 'Investigate flaky test',
      type: 'development',
      assigned: 'alice',
    });

    assert.equal(upsertTask.mock.callCount(), 1);
  });

  test('uses the space\'s configured proactivityThreshold instead of the fixed default', async (t) => {
    const readActiveConfig = t.mock.fn(async () => ({ config: { proactivityThreshold: 0.5 } }));
    const upsertTask = t.mock.fn(async (params) => {
      if (params.patch?.status === 'in_progress') {
        return { id: 'task_abc', type: 'development', assigned: 'agent', confidence: 0.6, status: 'in_progress' };
      }
      return { id: 'task_abc', type: 'development', assigned: 'agent', confidence: 0.6, status: 'unapproved' };
    });
    const { writeTaskTool } = loadTool(t, { upsertTask, readActiveConfig });
    const tool = writeTaskTool();

    // 0.6 sits below the fixed 0.7 default but above this space's lowered
    // 0.5 threshold — auto-approval should fire only because of the
    // per-space override.
    const result = await tool.execute('id-1', {
      spaceId: 'space-1',
      title: 'Investigate flaky test',
      type: 'development',
      assigned: 'agent',
      confidence: 0.6,
    });

    assert.equal(readActiveConfig.mock.callCount(), 1);
    assert.equal(upsertTask.mock.callCount(), 2);
    assert.equal(result.task.status, 'in_progress');
  });

  test('falls back to the fixed default threshold when the space has no active config', async (t) => {
    const readActiveConfig = t.mock.fn(async () => null);
    const upsertTask = t.mock.fn(async () => ({
      id: 'task_abc',
      type: 'development',
      assigned: 'agent',
      confidence: 0.6,
      status: 'unapproved',
    }));
    const { writeTaskTool } = loadTool(t, { upsertTask, readActiveConfig });
    const tool = writeTaskTool();

    // 0.6 clears no configured space threshold, so it must fall back to the
    // mocked CONFIDENCE_AUTO_APPROVE_THRESHOLD of 0.7 and not auto-approve.
    await tool.execute('id-1', {
      spaceId: 'space-1',
      title: 'Investigate flaky test',
      type: 'development',
      assigned: 'agent',
      confidence: 0.6,
    });

    assert.equal(upsertTask.mock.callCount(), 1);
  });

  test('does not re-trigger auto-approval on a patch whose prior status was already past unapproved', async (t) => {
    const readTasksState = t.mock.fn(async () => ({
      tasks: [{ id: 'task_abc', status: 'in_review' }],
    }));
    const upsertTask = t.mock.fn(async () => ({
      id: 'task_abc',
      type: 'development',
      assigned: 'agent',
      confidence: 0.95,
      status: 'in_review',
    }));
    const { writeTaskTool } = loadTool(t, { upsertTask, readTasksState });
    const tool = writeTaskTool();

    await tool.execute('id-1', { spaceId: 'space-1', id: 'task_abc', confidence: 0.95 });

    assert.equal(upsertTask.mock.callCount(), 1);
  });
});

describe('search_tasks tool', () => {
  function loadTool(t, overrides = {}) {
    const searchTasks =
      overrides.searchTasks ??
      t.mock.fn(async () => [{ id: 'task_abc', type: 'development' }]);
    const loaded = loadWithMocks(require.resolve('../processing/search-tasks-tool'), {
      [require.resolve('../storage/tasks-store')]: { searchTasks },
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
