'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { createAudioMonitor } = require('./audio-monitor');

// audio-monitor.js is browser code (WebAudio + window). Drive it in Node by
// faking just the surface it touches: window.AudioContext, a MediaStream, the
// interval timer, and the clock — so the audibility state machine can be
// exercised deterministically without a real browser.
function withFakeEnv(run) {
  const realWindow = global.window;
  const realSetInterval = global.setInterval;
  const realClearInterval = global.clearInterval;
  const realDateNow = Date.now;

  let level = 0; // amplitude every sample of the fake waveform carries
  let now = 0;
  const intervals = [];
  const contexts = [];

  class FakeAnalyser {
    constructor() { this.fftSize = 2048; }
    connect() {}
    disconnect() {}
    getFloatTimeDomainData(arr) { arr.fill(level); }
  }
  class FakeAudioContext {
    constructor() { this.state = 'running'; this.destination = {}; this.closed = false; contexts.push(this); }
    createMediaStreamSource() { return { connect() {}, disconnect() {} }; }
    createAnalyser() { return new FakeAnalyser(); }
    createGain() { return { gain: { value: 1 }, connect() {}, disconnect() {} }; }
    async resume() {}
    async close() { this.state = 'closed'; this.closed = true; }
  }

  global.window = { AudioContext: FakeAudioContext };
  global.setInterval = (fn) => { const handle = { fn }; intervals.push(handle); return handle; };
  global.clearInterval = (handle) => { if (handle) handle.cleared = true; };
  Date.now = () => now;

  const track = { listeners: {}, addEventListener(evt, fn) { this.listeners[evt] = fn; } };
  const stream = { getAudioTracks: () => [track] };

  const env = {
    stream,
    track,
    setLevel: (value) => { level = value; },
    advance: (ms) => { now += ms; },
    tickAll: () => intervals.filter((i) => !i.cleared).forEach((i) => i.fn()),
    contexts,
    intervals,
  };

  try {
    run(env);
  } finally {
    global.window = realWindow;
    global.setInterval = realSetInterval;
    global.clearInterval = realClearInterval;
    Date.now = realDateNow;
  }
}

test('logs when it starts listening and when audio becomes audible then quiet', () => {
  withFakeEnv((env) => {
    const logs = [];
    const monitor = createAudioMonitor({ meetingId: 'm1', report: (level, message) => logs.push({ level, message }) });

    env.setLevel(0); // silent
    monitor.attachStream(env.stream);
    assert.match(logs.at(-1).message, /listening to meeting audio \(meeting m1\)/);

    // Silence must not be reported as audible.
    env.tickAll();
    assert.ok(!logs.some((l) => /audible/.test(l.message)));

    // Loud audio → a single "audible" log on the rising edge.
    env.setLevel(0.2);
    env.advance(500);
    env.tickAll();
    env.advance(500);
    env.tickAll();
    const audibleLogs = logs.filter((l) => /meeting audio is audible/.test(l.message));
    assert.equal(audibleLogs.length, 1);
    assert.match(audibleLogs[0].message, /rms=0\.2000/);

    // Falling edge only after the silence hold elapses.
    env.setLevel(0);
    env.advance(500);
    env.tickAll();
    assert.ok(!logs.some((l) => /went quiet/.test(l.message)), 'brief pause must not flap to quiet');
    env.advance(2000);
    env.tickAll();
    assert.match(logs.at(-1).message, /meeting audio went quiet/);
  });
});

test('re-confirms sustained audio with a throttled heartbeat', () => {
  withFakeEnv((env) => {
    const logs = [];
    const monitor = createAudioMonitor({ meetingId: 'm2', report: (level, message) => logs.push(message) });

    env.setLevel(0.15);
    monitor.attachStream(env.stream);
    env.tickAll(); // rising edge → "is audible"

    // Within the 30s heartbeat window: no repeat logs.
    for (let i = 0; i < 10; i += 1) { env.advance(500); env.tickAll(); }
    assert.equal(logs.filter((m) => /still receiving audible audio/.test(m)).length, 0);

    // Past the heartbeat window: exactly one confirmation.
    env.advance(30_000);
    env.tickAll();
    assert.equal(logs.filter((m) => /still receiving audible audio/.test(m)).length, 1);
  });
});

test('stop() clears the meter interval and closes the audio context', () => {
  withFakeEnv((env) => {
    const monitor = createAudioMonitor({ meetingId: 'm3', report: () => {} });
    monitor.attachStream(env.stream);
    assert.equal(env.contexts.length, 1);

    monitor.stop();
    assert.equal(env.intervals.at(-1).cleared, true);
    assert.equal(env.contexts[0].closed, true);

    // Idempotent and inert after stop.
    monitor.stop();
    env.setLevel(0.3);
    env.tickAll();
  });
});

test('a stream with no audio track is reported, not metered', () => {
  withFakeEnv((env) => {
    const logs = [];
    const monitor = createAudioMonitor({ meetingId: 'm4', report: (level, message) => logs.push({ level, message }) });
    monitor.attachStream({ getAudioTracks: () => [] });
    assert.equal(logs.at(-1).level, 'warn');
    assert.match(logs.at(-1).message, /no audio track/);
    assert.equal(env.contexts.length, 0);
  });
});
