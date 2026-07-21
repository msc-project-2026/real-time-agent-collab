'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  classifyMeetingKind,
  resolveDestination,
  fetchMeetingWithRetry,
  isRoomMember,
  isActiveMeeting,
  listActiveMeetings,
} = require('./meetings');

test('classifyMeetingKind maps Webex meetingType values', () => {
  assert.equal(classifyMeetingKind({ meetingType: 'meeting' }), 'instant');
  assert.equal(classifyMeetingKind({ meetingType: 'scheduledMeeting' }), 'scheduled');
  assert.equal(classifyMeetingKind({ meetingType: 'meetingSeries' }), 'series');
  assert.equal(classifyMeetingKind({ meetingType: 'somethingElse' }), 'unknown');
  assert.equal(classifyMeetingKind({}), 'unknown');
});

test('resolveDestination prefers the human webLink and never falls back to roomId', () => {
  assert.deepEqual(
    resolveDestination({
      webLink: 'https://example.webex.com/example/j.php?MTID=abc',
      sipUrl: 'sip:abc@webex.com',
      id: 'meeting-1',
      roomId: 'room-1',
    }),
    { destination: 'https://example.webex.com/example/j.php?MTID=abc', type: 'MEETING_LINK' }
  );
  assert.deepEqual(resolveDestination({ id: 'meeting-1', roomId: 'room-1' }), { destination: 'meeting-1', type: 'MEETING_ID' });
  assert.deepEqual(resolveDestination({ sipAddress: '123@example.webex.com' }), { destination: '123@example.webex.com', type: 'SIP_URI' });
  assert.throws(() => resolveDestination({ roomId: 'room-1' }), /no human webLink/);
  assert.throws(() => resolveDestination({}), /no human webLink/);
});

test('fetchMeetingWithRetry retries on failure and eventually succeeds', async () => {
  let calls = 0;
  const fakeFetch = async () => {
    calls += 1;
    if (calls < 3) throw new Error('not ready yet');
    return { id: 'meeting-1' };
  };
  const result = await fetchMeetingWithRetry(fakeFetch, 'meeting-1', { attempts: 3, delayMs: 1 });
  assert.deepEqual(result, { id: 'meeting-1' });
  assert.equal(calls, 3);
});

test('fetchMeetingWithRetry gives up after exhausting attempts', async () => {
  const fakeFetch = async () => {
    throw new Error('permanently broken');
  };
  await assert.rejects(
    fetchMeetingWithRetry(fakeFetch, 'meeting-1', { attempts: 2, delayMs: 1 }),
    /permanently broken/
  );
});

test('isRoomMember checks the memberships endpoint', async () => {
  const calls = [];
  const fakeFetch = async (path) => {
    calls.push(path);
    return path.includes('roomId=room-1') ? { items: [{ id: 'm1' }] } : { items: [] };
  };
  assert.equal(await isRoomMember(fakeFetch, 'room-1', 'person-1'), true);
  assert.equal(await isRoomMember(fakeFetch, 'room-2', 'person-1'), false);
  assert.equal(await isRoomMember(fakeFetch, null, 'person-1'), false);
});

test('isActiveMeeting recognizes started/in-progress states', () => {
  assert.equal(isActiveMeeting({ state: 'inprogress' }), true);
  assert.equal(isActiveMeeting({ status: 'active' }), true);
  assert.equal(isActiveMeeting({ actualStart: '2026-01-01T00:00:00Z' }), true);
  assert.equal(isActiveMeeting({ actualStart: '2026-01-01T00:00:00Z', actualEnd: '2026-01-01T01:00:00Z' }), false);
  assert.equal(isActiveMeeting({ state: 'scheduled' }), false);
});

test('listActiveMeetings filters the raw REST response down to active ones', async () => {
  const fakeFetch = async () => ({
    items: [
      { id: 'm1', state: 'inprogress' },
      { id: 'm2', state: 'scheduled' },
      { id: 'm3', actualStart: '2026-01-01T00:00:00Z' },
    ],
  });
  const active = await listActiveMeetings(fakeFetch);
  assert.deepEqual(active.map((m) => m.id), ['m1', 'm3']);
});
