'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { activeOnThisDevice, findMeeting } = require('./sdk-meeting-state');

test('detects the SDK browser device in joined and lobby states', () => {
  assert.equal(activeOnThisDevice({ joinedWith: { state: 'JOINED' } }), true);
  assert.equal(activeOnThisDevice({
    locusInfo: { parsedLocus: { self: { joinedWith: { state: 'IDLE', intent: { type: 'WAIT' } } } } },
  }), true);
  assert.equal(activeOnThisDevice({ joinedWith: { state: 'LEFT' } }), false);
  assert.equal(activeOnThisDevice({ locusInfo: { parsedLocus: { self: { state: 'JOINED' } } } }), false);
});

test('prefers the active synced Meeting object over the failed original object', () => {
  const failed = { id: 'local-failed', destination: 'sip:space@example.com' };
  const synced = {
    id: 'synced-active',
    meetingInfo: { sipUri: 'sip:space@example.com' },
    joinedWith: { state: 'JOINED' },
  };

  assert.equal(findMeeting(failed, [failed, synced], { activeOnly: true }), synced);
});

test('uses a sole active local meeting when Webex changes every identifier', () => {
  const active = { id: 'new-sdk-id', joinedWith: { state: 'JOINED' } };
  assert.equal(findMeeting({ meetingId: 'rest-id' }, [active], { activeOnly: true }), active);
});

test('never guesses between multiple unrelated active meetings', () => {
  const meetings = [
    { id: 'one', joinedWith: { state: 'JOINED' } },
    { id: 'two', joinedWith: { state: 'JOINED' } },
  ];
  assert.equal(findMeeting({ meetingId: 'unknown' }, meetings, { activeOnly: true }), null);
});
