'use strict';

const assert = require('node:assert/strict');
const { describe, test } = require('node:test');

async function loadModel() {
  return import('../board/src/model.js');
}

// Category: Collaboration board domain model.
// These tests verify the data semantics behind board rendering and
// interactions against the v3 §7c single-status-axis task schema: backend
// normalization, review classification, summary counts, and task filtering.
describe('collaboration board domain model', () => {
  test('normalises backend tasks without mutating their supplied fields', async () => {
    const { normalizeTask } = await loadModel();
    const source = { id: 'task-1', type: 'development', assigned: 'alice' };

    assert.deepEqual(normalizeTask(source), {
      id: 'task-1',
      type: 'development',
      assigned: 'alice',
      title: '(untitled)',
      description: '',
      status: 'unapproved',
      deadline: 'unknown',
      message_ids: [],
      child_tasks: [],
    });
    assert.deepEqual(source, { id: 'task-1', type: 'development', assigned: 'alice' });

    const explicit = normalizeTask({
      id: 'task-2',
      title: 'Fix login test',
      description: 'Flaky on CI',
      type: 'research',
      status: 'in_review',
      assigned: 'bob',
      deadline: '2026-09-01',
      message_ids: ['msg-1'],
      child_tasks: ['task-3'],
    });
    assert.equal(explicit.title, 'Fix login test');
    assert.equal(explicit.description, 'Flaky on CI');
    assert.equal(explicit.status, 'in_review');
    assert.equal(explicit.assigned, 'bob');
    assert.equal(explicit.deadline, '2026-09-01');
    assert.deepEqual(explicit.message_ids, ['msg-1']);
    assert.deepEqual(explicit.child_tasks, ['task-3']);
  });

  test('empty title falls back to placeholder, not kept as empty string', async () => {
    const { normalizeTask } = await loadModel();
    assert.equal(normalizeTask({ id: 't', title: '' }).title, '(untitled)');
  });

  test('classifies review tasks and calculates every board summary count', async () => {
    const { buildBoardCounts, isReviewTask } = await loadModel();
    const tasks = [
      { type: 'development', status: 'unapproved' },
      { type: 'design', status: 'backlog' },
      { type: 'coordination', status: 'in_progress' },
      { type: 'design', status: 'in_review' },
      { type: 'research', status: 'done' },
      { type: 'development', status: 'archived' },
    ];

    assert.equal(isReviewTask(tasks[0]), true);
    assert.equal(isReviewTask(tasks[1]), false);
    assert.deepEqual(buildBoardCounts(tasks), {
      total: 6,
      unapproved: 1,
      backlog: 1,
      inProgress: 1,
      inReview: 1,
      done: 1,
      archived: 1,
    });
  });

  test('filters by type, status, and case-insensitive text across title/description/assigned', async () => {
    const { filterTasks } = await loadModel();
    const tasks = [
      {
        id: 'old-research',
        type: 'research',
        status: 'unapproved',
        title: 'Release RESEARCH',
        assigned: 'Alice',
        updatedAt: '2026-01-01T00:00:00.000Z',
      },
      {
        id: 'new-research',
        type: 'research',
        status: 'in_review',
        description: 'Release is IN PROGRESS',
        assigned: 'Bob',
        updatedAt: '2026-01-02T00:00:00.000Z',
      },
      { id: 'design', type: 'design', status: 'done', assigned: 'Carol' },
    ];

    assert.deepEqual(
      filterTasks(tasks, { typeFilter: 'research' }).map((t) => t.id),
      ['new-research', 'old-research']
    );
    assert.deepEqual(
      filterTasks(tasks, { statusFilter: 'in_review' }).map((t) => t.id),
      ['new-research']
    );
    assert.deepEqual(
      filterTasks(tasks, { search: 'release' }).map((t) => t.id),
      ['new-research', 'old-research']
    );
    assert.deepEqual(
      filterTasks(tasks, { search: 'carol' }).map((t) => t.id),
      ['design']
    );
    assert.deepEqual(filterTasks(tasks, { search: 'missing' }), []);
    assert.deepEqual(tasks.map((t) => t.id), [
      'old-research',
      'new-research',
      'design',
    ]);
  });

  test('resolveAssigneeName resolves a known member id to its name, falls back for unknown/unrecognized', async () => {
    const { resolveAssigneeName } = await loadModel();
    const members = [
      { id: 'alice@example.com', name: 'Alice' },
      { id: 'agent', name: 'Agent' },
    ];

    assert.equal(resolveAssigneeName('alice@example.com', members), 'Alice');
    assert.equal(resolveAssigneeName('agent', members), 'Agent');
    assert.equal(resolveAssigneeName('unknown', members), 'Unassigned');
    assert.equal(resolveAssigneeName(undefined, members), 'Unassigned');
    // Unrecognized value (not in the member list) — shown verbatim, not hidden.
    assert.equal(resolveAssigneeName('dave@example.com', members), 'dave@example.com');
  });

  test('filterTasks search also matches a resolved member name, not just the raw assigned id', async () => {
    const { filterTasks } = await loadModel();
    const members = [{ id: 'alice@example.com', name: 'Alice' }];
    const tasks = [
      { id: 'task-1', status: 'backlog', title: 'X', assigned: 'alice@example.com' },
      { id: 'task-2', status: 'backlog', title: 'Y', assigned: 'unknown' },
    ];

    assert.deepEqual(
      filterTasks(tasks, { search: 'alice', members }).map((t) => t.id),
      ['task-1']
    );
  });

  test('toDateInputValue/fromDateInputValue convert between the deadline string and a native date input', async () => {
    const { toDateInputValue, fromDateInputValue } = await loadModel();

    assert.equal(toDateInputValue('unknown'), '');
    assert.equal(toDateInputValue(undefined), '');
    assert.equal(toDateInputValue(''), '');
    assert.equal(toDateInputValue('2026-09-01'), '2026-09-01');
    assert.equal(toDateInputValue('2026-09-01T10:00:00.000Z'), '2026-09-01');

    assert.equal(fromDateInputValue(''), 'unknown');
    assert.equal(fromDateInputValue('2026-09-01'), '2026-09-01');
  });

  test('formats compact identifiers and optional dates for display', async () => {
    const { formatDate, shortId } = await loadModel();
    assert.equal(shortId(), '—');
    assert.equal(shortId('abcdefghijk'), 'abcdefgh');
    assert.equal(formatDate(), '—');
    assert.notEqual(formatDate('2026-08-14T10:00:00.000Z'), '—');
  });
});
