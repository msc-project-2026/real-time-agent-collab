'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { MeetingState } = require('./state');

test('markJoined/markLeft track membership and suppression', () => {
  const state = new MeetingState();
  assert.equal(state.isJoined('m1'), false);
  state.markJoined('m1', { roomId: 'r1', kind: 'instant' });
  assert.equal(state.isJoined('m1'), true);
  assert.deepEqual(state.findJoinedByRoom('r1'), { meetingId: 'm1', roomId: 'r1', kind: 'instant', joinedAt: state.joined.get('m1').joinedAt });

  state.markLeft('m1', { suppress: true });
  assert.equal(state.isJoined('m1'), false);
  assert.equal(state.isSuppressed('m1'), true);
});

test('markJoined clears a prior suppression (explicit re-join wins)', () => {
  const state = new MeetingState();
  state.suppressed.add('m1');
  state.markJoined('m1', { roomId: 'r1' });
  assert.equal(state.isSuppressed('m1'), false);
});

test('withLock coalesces concurrent calls for the same meetingId into one execution', async () => {
  const state = new MeetingState();
  let calls = 0;
  const task = () => new Promise((resolve) => {
    calls += 1;
    setTimeout(() => resolve('done'), 10);
  });

  const [a, b] = await Promise.all([
    state.withLock('m1', task),
    state.withLock('m1', task),
  ]);
  assert.equal(calls, 1);
  assert.equal(a, 'done');
  assert.equal(b, 'done');

  // A later, non-overlapping call gets its own execution.
  await state.withLock('m1', task);
  assert.equal(calls, 2);
});

test('findJoinedByRoom returns null when nothing is joined in that room', () => {
  const state = new MeetingState();
  assert.equal(state.findJoinedByRoom('nope'), null);
});
