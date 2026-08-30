'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { createWebexTranscriptionManager } = require('./webex-transcription');

test('emits each final Webex caption once with meeting identity', () => {
  const turns = [];
  const manager = createWebexTranscriptionManager({ onTurn: (turn) => turns.push(turn) });
  manager.startSession({ sdkMeetingId: 'sdk-1', meetingId: 'meeting-1', roomId: 'room-1' });
  const payload = { captions: [
    { id: 'interim', isFinal: false, text: 'Hel' },
    { id: 'final-1', isFinal: true, text: 'Hello there', timestamp: '0:01', speaker: { speakerId: 'p1', name: 'Ada' } },
  ] };

  manager.pushCaptions('sdk-1', payload);
  manager.pushCaptions('sdk-1', payload);

  assert.deepEqual(turns, [{
    sdkMeetingId: 'sdk-1',
    meetingId: 'meeting-1',
    roomId: 'room-1',
    transcript: 'Hello there',
    timestamp: '0:01',
    speaker: { speakerId: 'p1', name: 'Ada' },
  }]);
});

test('ignores captions outside an active session', () => {
  const turns = [];
  const manager = createWebexTranscriptionManager({ onTurn: (turn) => turns.push(turn) });
  manager.startSession({ sdkMeetingId: 'sdk-1', meetingId: 'meeting-1', roomId: 'room-1' });
  manager.endSession('sdk-1');
  manager.pushCaptions('sdk-1', { captions: [{ id: '1', isFinal: true, text: 'Ignored' }] });
  assert.deepEqual(turns, []);
});
