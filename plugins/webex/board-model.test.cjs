'use strict';

const assert = require('node:assert/strict');
const { describe, test } = require('node:test');

async function loadModel() {
  return import('./board/src/model.js');
}

// Category: Collaboration board domain model.
// These tests verify the data semantics behind board rendering and interactions:
// backend normalization, work classification, summary counts, and record filtering.
describe('collaboration board domain model', () => {
  test('normalises backend items without mutating their supplied fields', async () => {
    const { normalizeItem } = await loadModel();
    const source = { id: 'item-1', type: 'task', owner: 'Alice' };

    assert.deepEqual(normalizeItem(source), {
      id: 'item-1',
      type: 'task',
      owner: 'Alice',
      title: '(untitled)',
      approvalStatus: 'proposed',
      assignee: 'Alice',
      assigneeType: null,
      delegationStatus: 'not_delegated',
    });
    assert.deepEqual(source, { id: 'item-1', type: 'task', owner: 'Alice' });

    const explicit = normalizeItem({
      id: 'item-2',
      title: '',
      approvalStatus: 'approved',
      assignee: 'Bob',
      assigneeType: 'person',
      delegationStatus: 'queued',
    });
    assert.equal(explicit.title, '');
    assert.equal(explicit.approvalStatus, 'approved');
    assert.equal(explicit.assignee, 'Bob');
    assert.equal(explicit.assigneeType, 'person');
    assert.equal(explicit.delegationStatus, 'queued');
  });

  test('classifies work items and calculates every board summary count', async () => {
    const { buildBoardCounts, isWorkItem } = await loadModel();
    const items = [
      { type: 'task', status: 'open', approvalStatus: 'proposed' },
      { type: 'issue', status: 'in_progress', approvalStatus: 'approved' },
      { type: 'risk', status: 'blocked', approvalStatus: 'proposed' },
      { type: 'decision', status: 'resolved', approvalStatus: 'approved' },
    ];

    assert.equal(isWorkItem(items[0]), true);
    assert.equal(isWorkItem(items[1]), true);
    assert.equal(isWorkItem(items[2]), false);
    assert.deepEqual(buildBoardCounts(items), {
      total: 4,
      proposed: 2,
      approved: 2,
      open: 1,
      in_progress: 1,
      blocked: 1,
      resolved: 1,
      risks: 1,
      decisions: 1,
    });
  });

  test('filters by type, status, and case-insensitive record text', async () => {
    const { filterProjectItems } = await loadModel();
    const items = [
      {
        id: 'old-risk',
        type: 'risk',
        status: 'open',
        title: 'Release RISK',
        owner: 'Alice',
        updatedAt: '2026-01-01T00:00:00.000Z',
      },
      {
        id: 'new-risk',
        type: 'risk',
        status: 'blocked',
        description: 'Release is BLOCKED',
        owner: 'Bob',
        updatedAt: '2026-01-02T00:00:00.000Z',
      },
      { id: 'decision', type: 'decision', status: 'resolved', owner: 'Carol' },
    ];

    assert.deepEqual(
      filterProjectItems(items, { typeFilter: 'risk' }).map((item) => item.id),
      ['new-risk', 'old-risk']
    );
    assert.deepEqual(
      filterProjectItems(items, { statusFilter: 'blocked' }).map((item) => item.id),
      ['new-risk']
    );
    assert.deepEqual(
      filterProjectItems(items, { search: 'release' }).map((item) => item.id),
      ['new-risk', 'old-risk']
    );
    assert.deepEqual(
      filterProjectItems(items, { search: 'carol' }).map((item) => item.id),
      ['decision']
    );
    assert.deepEqual(filterProjectItems(items, { search: 'missing' }), []);
    assert.deepEqual(items.map((item) => item.id), [
      'old-risk',
      'new-risk',
      'decision',
    ]);
  });

  test('formats compact identifiers and optional dates for display', async () => {
    const { formatDate, shortId } = await loadModel();
    assert.equal(shortId(), '—');
    assert.equal(shortId('abcdefghijk'), 'abcdefgh');
    assert.equal(formatDate(), '—');
    assert.notEqual(formatDate('2026-08-14T10:00:00.000Z'), '—');
  });
});
