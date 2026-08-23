'use strict';

const assert = require('node:assert/strict');
const { describe, test } = require('node:test');

const { makeTempWorkspace } = require('./helpers.cjs');
const {
  readTasksState,
  upsertTask,
  getActiveTasks,
  getTasks,
  searchTasks,
  getParentTasks,
  wouldCreateCycle,
} = require('../context/tasks-store');

// ---------------------------------------------------------------------------
// v3 §7c task schema (phase 6). Covers create/update round-trip via the
// single upsertTask entry point, active/status/type querying, keyword search,
// and the child_tasks reverse-index + cycle rejection.
// ---------------------------------------------------------------------------

describe('tasks-store — upsert', () => {
  test('creates a task with defaults for omitted optional fields', async (t) => {
    const root = await makeTempWorkspace(t);

    const task = await upsertTask({
      spaceId: 'space-1',
      explicitRoot: root,
      patch: { type: 'development', message_ids: ['msg-1'] },
    });

    assert.match(task.id, /^task_/);
    assert.equal(task.type, 'development');
    assert.equal(task.assigned, 'unknown');
    assert.equal(task.deadline, 'unknown');
    assert.equal(task.status, 'open');
    assert.deepEqual(task.message_ids, ['msg-1']);
    assert.deepEqual(task.child_tasks, []);
    assert.ok(task.createdAt);
    assert.equal(task.createdAt, task.updatedAt);

    const state = await readTasksState({ spaceId: 'space-1', explicitRoot: root });
    assert.equal(state.tasks.length, 1);
  });

  test('creating without `type` throws', async (t) => {
    const root = await makeTempWorkspace(t);

    await assert.rejects(
      upsertTask({ spaceId: 'space-1', explicitRoot: root, patch: {} }),
      /`type` is required/
    );
  });

  test('patching an existing task only changes fields actually passed', async (t) => {
    const root = await makeTempWorkspace(t);

    const created = await upsertTask({
      spaceId: 'space-1',
      explicitRoot: root,
      patch: { type: 'development', assigned: 'alice', message_ids: ['msg-1'] },
    });

    const updated = await upsertTask({
      spaceId: 'space-1',
      explicitRoot: root,
      id: created.id,
      patch: { status: 'approved' },
    });

    assert.equal(updated.id, created.id);
    assert.equal(updated.status, 'approved');
    // Untouched fields survive the patch.
    assert.equal(updated.type, 'development');
    assert.equal(updated.assigned, 'alice');
    assert.deepEqual(updated.message_ids, ['msg-1']);
  });

  test('patching an unknown id throws', async (t) => {
    const root = await makeTempWorkspace(t);

    await assert.rejects(
      upsertTask({
        spaceId: 'space-1',
        explicitRoot: root,
        id: 'task_does-not-exist',
        patch: { status: 'done' },
      }),
      /task not found/
    );
  });

  test('message_ids accumulate without duplicates, never replaced wholesale', async (t) => {
    const root = await makeTempWorkspace(t);

    const created = await upsertTask({
      spaceId: 'space-1',
      explicitRoot: root,
      patch: { type: 'development', message_ids: ['msg-1', 'msg-2'] },
    });

    const updated = await upsertTask({
      spaceId: 'space-1',
      explicitRoot: root,
      id: created.id,
      patch: { message_ids: ['msg-2', 'msg-3'] },
    });

    assert.deepEqual(updated.message_ids, ['msg-1', 'msg-2', 'msg-3']);
  });
});

describe('tasks-store — queries', () => {
  test('getActiveTasks excludes only archived', async (t) => {
    const root = await makeTempWorkspace(t);

    const statuses = ['open', 'approved', 'delegated', 'done', 'archived'];
    for (const status of statuses) {
      await upsertTask({
        spaceId: 'space-1',
        explicitRoot: root,
        patch: { type: 'development', status },
      });
    }

    const active = await getActiveTasks({ spaceId: 'space-1', explicitRoot: root });
    assert.deepEqual(
      active.map((task) => task.status).sort(),
      ['approved', 'delegated', 'done', 'open']
    );
  });

  test('getTasks filters by statuses, types, and messageIds', async (t) => {
    const root = await makeTempWorkspace(t);

    await upsertTask({
      spaceId: 'space-1',
      explicitRoot: root,
      patch: { type: 'development', status: 'open', message_ids: ['msg-1'] },
    });
    await upsertTask({
      spaceId: 'space-1',
      explicitRoot: root,
      patch: { type: 'research', status: 'done', message_ids: ['msg-2'] },
    });

    const byStatus = await getTasks({
      spaceId: 'space-1',
      explicitRoot: root,
      statuses: ['done'],
    });
    assert.equal(byStatus.length, 1);
    assert.equal(byStatus[0].type, 'research');

    const byType = await getTasks({
      spaceId: 'space-1',
      explicitRoot: root,
      types: ['development'],
    });
    assert.equal(byType.length, 1);
    assert.equal(byType[0].status, 'open');

    const byMessage = await getTasks({
      spaceId: 'space-1',
      explicitRoot: root,
      messageIds: ['msg-2'],
    });
    assert.equal(byMessage.length, 1);
    assert.equal(byMessage[0].type, 'research');
  });

  test('searchTasks matches on type/assigned/id, respects includeArchived', async (t) => {
    const root = await makeTempWorkspace(t);

    const archived = await upsertTask({
      spaceId: 'space-1',
      explicitRoot: root,
      patch: { type: 'design', assigned: 'bob', status: 'archived' },
    });
    await upsertTask({
      spaceId: 'space-1',
      explicitRoot: root,
      patch: { type: 'development', assigned: 'alice' },
    });

    const withArchived = await searchTasks({
      spaceId: 'space-1',
      explicitRoot: root,
      query: 'bob',
    });
    assert.equal(withArchived.length, 1);
    assert.equal(withArchived[0].id, archived.id);

    const withoutArchived = await searchTasks({
      spaceId: 'space-1',
      explicitRoot: root,
      query: 'bob',
      includeArchived: false,
    });
    assert.equal(withoutArchived.length, 0);

    const byType = await searchTasks({
      spaceId: 'space-1',
      explicitRoot: root,
      query: 'development',
    });
    assert.equal(byType.length, 1);
    assert.equal(byType[0].assigned, 'alice');
  });
});

describe('tasks-store — child_tasks, reverse index, cycle rejection', () => {
  test('adding a child_tasks edge is reflected in the reverse parent index', async (t) => {
    const root = await makeTempWorkspace(t);

    const parent = await upsertTask({
      spaceId: 'space-1',
      explicitRoot: root,
      patch: { type: 'development' },
    });
    const child = await upsertTask({
      spaceId: 'space-1',
      explicitRoot: root,
      patch: { type: 'development' },
    });

    const updatedParent = await upsertTask({
      spaceId: 'space-1',
      explicitRoot: root,
      id: parent.id,
      patch: { child_tasks: [child.id] },
    });

    assert.deepEqual(updatedParent.child_tasks, [child.id]);

    const parents = await getParentTasks(child.id, { spaceId: 'space-1', explicitRoot: root });
    assert.deepEqual(parents, [parent.id]);
  });

  test('child_tasks accumulate without duplicates', async (t) => {
    const root = await makeTempWorkspace(t);

    const parent = await upsertTask({ spaceId: 'space-1', explicitRoot: root, patch: { type: 'development' } });
    const childA = await upsertTask({ spaceId: 'space-1', explicitRoot: root, patch: { type: 'development' } });
    const childB = await upsertTask({ spaceId: 'space-1', explicitRoot: root, patch: { type: 'development' } });

    await upsertTask({ spaceId: 'space-1', explicitRoot: root, id: parent.id, patch: { child_tasks: [childA.id] } });
    const twice = await upsertTask({
      spaceId: 'space-1',
      explicitRoot: root,
      id: parent.id,
      patch: { child_tasks: [childA.id, childB.id] },
    });

    assert.deepEqual(twice.child_tasks, [childA.id, childB.id]);
  });

  test('a direct self-reference is rejected', async (t) => {
    const root = await makeTempWorkspace(t);

    const task = await upsertTask({ spaceId: 'space-1', explicitRoot: root, patch: { type: 'development' } });

    await assert.rejects(
      upsertTask({
        spaceId: 'space-1',
        explicitRoot: root,
        id: task.id,
        patch: { child_tasks: [task.id] },
      }),
      /self-referential/
    );
  });

  test('a transitive cycle (A -> B -> C -> A) is rejected on the closing edge', async (t) => {
    const root = await makeTempWorkspace(t);

    const a = await upsertTask({ spaceId: 'space-1', explicitRoot: root, patch: { type: 'development' } });
    const b = await upsertTask({ spaceId: 'space-1', explicitRoot: root, patch: { type: 'development' } });
    const c = await upsertTask({ spaceId: 'space-1', explicitRoot: root, patch: { type: 'development' } });

    await upsertTask({ spaceId: 'space-1', explicitRoot: root, id: a.id, patch: { child_tasks: [b.id] } });
    await upsertTask({ spaceId: 'space-1', explicitRoot: root, id: b.id, patch: { child_tasks: [c.id] } });

    await assert.rejects(
      upsertTask({ spaceId: 'space-1', explicitRoot: root, id: c.id, patch: { child_tasks: [a.id] } }),
      /would create a cycle/
    );
  });

  test('two independent children of the same parent (A->B, A->C) are both fine', async (t) => {
    const root = await makeTempWorkspace(t);

    const a = await upsertTask({ spaceId: 'space-1', explicitRoot: root, patch: { type: 'development' } });
    const b = await upsertTask({ spaceId: 'space-1', explicitRoot: root, patch: { type: 'development' } });
    const c = await upsertTask({ spaceId: 'space-1', explicitRoot: root, patch: { type: 'development' } });

    const updated = await upsertTask({
      spaceId: 'space-1',
      explicitRoot: root,
      id: a.id,
      patch: { child_tasks: [b.id, c.id] },
    });

    assert.deepEqual(updated.child_tasks, [b.id, c.id]);
    // b and c are siblings (both children of a) — neither is an ancestor of
    // the other, so a hypothetical b<->c edge in either direction is fine.
    assert.equal(
      await wouldCreateCycle({ spaceId: 'space-1', explicitRoot: root, parentId: b.id, childId: c.id }),
      false
    );
    // But the reverse of an edge that already exists (b -> a, when a -> b is
    // already recorded) would close a cycle: a is already an ancestor of b.
    assert.equal(
      await wouldCreateCycle({ spaceId: 'space-1', explicitRoot: root, parentId: b.id, childId: a.id }),
      true
    );
  });
});
