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

test('resolveDestination prefers the SDK SIP address, not the human webLink', () => {
  assert.deepEqual(
    resolveDestination({
      webLink: 'https://example.webex.com/example/j.php?MTID=abc',
      sipUrl: 'sip:abc@webex.com',
      id: 'meeting-1',
      roomId: 'room-1',
    }),
    { destination: 'sip:abc@webex.com', type: 'SIP_URI' }
  );
  assert.deepEqual(
    resolveDestination({ sipAddress: '123456789@example.webex.com', id: 'meeting-1' }),
    { destination: '123456789@example.webex.com', type: 'SIP_URI' }
  );
  assert.deepEqual(resolveDestination({ id: 'meeting-1', roomId: 'room-1' }), { destination: 'meeting-1', type: 'MEETING_ID' });
  assert.throws(() => resolveDestination({ webLink: 'https://example.webex.com/meet/person', roomId: 'room-1' }), /no SDK meeting id or SIP address/);
  assert.throws(() => resolveDestination({ roomId: 'room-1' }), /no SDK meeting id or SIP address/);
  assert.throws(() => resolveDestination({}), /no SDK meeting id or SIP address/);
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
  const requestedPaths = [];
  const fakeFetch = async (path) => {
    requestedPaths.push(path);
    return {
      items: [
        { id: 'm1', state: 'inprogress' },
        { id: 'm2', state: 'scheduled' },
        { id: 'm3', actualStart: '2026-01-01T00:00:00Z' },
      ],
    };
  };
  const now = Date.parse('2026-01-02T12:00:00Z');
  const active = await listActiveMeetings(fakeFetch, now, { lookbackMs: 24 * 60 * 60 * 1000 });
  assert.deepEqual(active.map((m) => m.id), ['m1', 'm3']);
  assert.match(requestedPaths[0], /from=2026-01-01T12%3A00%3A00.000Z/);
});

// The regression this guards: `GET /meetings` defaults to
// meetingType=meetingSeries, so an instant/ad-hoc meeting (which exists only
// as an instance) was never listed and `/meeting join` could not find it.
test('listActiveMeetings also asks for instant/ad-hoc meeting instances', async () => {
  const requestedPaths = [];
  const fakeFetch = async (path) => {
    requestedPaths.push(path);
    if (path.includes('meetingType=meeting')) {
      return { items: [{ id: 'instant-1', meetingType: 'meeting', state: 'inProgress' }] };
    }
    return { items: [] }; // no scheduled series in progress
  };
  const active = await listActiveMeetings(fakeFetch);
  assert.deepEqual(active.map((m) => m.id), ['instant-1']);
  assert.equal(requestedPaths.length, 2);
  assert.match(requestedPaths.find((p) => p.includes('meetingType=meeting')), /state=inProgress/);
});

test('listActiveMeetings collapses a scheduled series and its running instance', async () => {
  const fakeFetch = async (path) => (path.includes('meetingType=meeting')
    ? { items: [{ id: 'instance-1', meetingSeriesId: 'series-1', state: 'inProgress' }] }
    : { items: [{ id: 'series-1', state: 'inProgress' }] });
  const active = await listActiveMeetings(fakeFetch);
  assert.deepEqual(active.map((m) => m.id), ['series-1']);
});

test('listActiveMeetings survives one query variant failing', async () => {
  const fakeFetch = async (path) => {
    if (path.includes('meetingType=meeting')) throw new Error('400 unsupported');
    return { items: [{ id: 'series-1', state: 'inProgress' }] };
  };
  const active = await listActiveMeetings(fakeFetch);
  assert.deepEqual(active.map((m) => m.id), ['series-1']);

  await assert.rejects(
    listActiveMeetings(async () => { throw new Error('token expired'); }),
    /token expired/
  );
});
