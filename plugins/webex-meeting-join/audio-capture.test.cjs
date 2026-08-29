'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { createPcmCapture } = require('./audio-capture');

test('warns and returns a safe stop handle when WebAudio or an audio track is unavailable', (t) => {
  const originalWindow = global.window;
  t.after(() => { global.window = originalWindow; });
  const logs = [];
  global.window = {};
  createPcmCapture({ stream: {}, report: (...entry) => logs.push(entry) }).stop();
  global.window = { AudioContext: class {} };
  createPcmCapture({ stream: { getAudioTracks: () => [] }, report: (...entry) => logs.push(entry) }).stop();
  assert.deepEqual(logs, [
    ['warn', 'WebAudio unavailable; cannot capture meeting audio for transcription'],
    ['warn', 'remote stream has no audio track to capture for transcription'],
  ]);
});

test('converts PCM frames, reports forwarding failures, and releases WebAudio resources once', (t) => {
  const originalWindow = global.window;
  t.after(() => { global.window = originalWindow; });
  const logs = [];
  const sent = [];
  let processor;
  let sourceDisconnected = 0;
  let processorDisconnected = 0;
  let closed = 0;
  class AudioContext {
    constructor(options) { this.options = options; this.destination = {}; this.state = 'running'; }
    createMediaStreamSource() { return { connect() {}, disconnect() { sourceDisconnected += 1; } }; }
    createScriptProcessor(size, input, output) {
      assert.deepEqual([size, input, output], [4096, 1, 1]);
      processor = { connect() {}, disconnect() { processorDisconnected += 1; } };
      return processor;
    }
    resume() { return Promise.resolve(); }
    close() { closed += 1; this.state = 'closed'; return Promise.resolve(); }
  }
  global.window = { AudioContext };
  let ended;
  const capture = createPcmCapture({
    stream: { getAudioTracks: () => [{ addEventListener: (event, callback) => { if (event === 'ended') ended = callback; } }] },
    sendPcm: (frame) => { sent.push(frame); if (sent.length === 2) throw new Error('binding unavailable'); },
    report: (...entry) => logs.push(entry),
  });
  processor.onaudioprocess({ inputBuffer: { getChannelData: () => new Float32Array([1, -1, 0.5]) } });
  assert.equal(Buffer.from(sent[0], 'base64').toString('hex'), 'ff7f0080ff3f');
  processor.onaudioprocess({ inputBuffer: { getChannelData: () => new Float32Array([0]) } });
  assert.ok(logs.some(([level, text]) => level === 'warn' && /failed to forward audio frame/.test(text)));
  ended();
  capture.stop();
  assert.equal(processorDisconnected, 1);
  assert.equal(sourceDisconnected, 1);
  assert.equal(closed, 1);
  assert.ok(logs.some(([level, text]) => level === 'info' && /capturing meeting audio/.test(text)));
});
