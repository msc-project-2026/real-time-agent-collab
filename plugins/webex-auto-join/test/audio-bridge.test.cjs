'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const WebSocket = require('ws');
const { AudioBridge, AUDIO_SAMPLE_RATE } = require('../dist/audio-bridge.cjs');

function collectLogger() {
  const lines = [];
  const record = (line) => lines.push(String(line));
  return { lines, info: record, warn: record, error: record };
}

// Alternating sign holds RMS at exactly `amplitude` while averaging to DC zero.
function pcmAtAmplitude(amplitude, samples) {
  const buffer = Buffer.alloc(samples * 2);
  const value = Math.round(amplitude * 0x7fff);
  for (let i = 0; i < samples; i += 1) buffer.writeInt16LE(i % 2 === 0 ? value : -value, i * 2);
  return buffer;
}

async function waitFor(predicate, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('timed out waiting for bridge output');
}

async function openTap(port, sessionId, token) {
  const socket = new WebSocket(`ws://127.0.0.1:${port}/?session=${encodeURIComponent(sessionId)}&token=${encodeURIComponent(token)}`);
  await new Promise((resolve, reject) => {
    socket.once('open', resolve);
    socket.once('error', reject);
  });
  return socket;
}

async function withBridge(run) {
  const logger = collectLogger();
  const bridge = new AudioBridge(logger, { reportIntervalMs: 0 });
  const port = await bridge.start();
  try { await run({ bridge, port, logger }); }
  finally { await bridge.stop(); }
}

test('reports the level of tapped audio against a known signal', async () => {
  await withBridge(async ({ bridge, port, logger }) => {
    const credentials = bridge.register('session-1');
    assert.equal(credentials.sampleRate, AUDIO_SAMPLE_RATE);

    const socket = await openTap(port, 'session-1', credentials.token);
    socket.send(JSON.stringify({ type: 'hello', sessionId: 'session-1', sampleRate: AUDIO_SAMPLE_RATE, channels: 1, encoding: 'linear16' }));
    // Exactly one second of half-scale audio.
    socket.send(pcmAtAmplitude(0.5, AUDIO_SAMPLE_RATE));

    await waitFor(() => logger.lines.some((line) => line.includes('rms=')));
    assert.match(logger.lines.find((line) => line.includes('audio tap open')), /rate=16000 encoding=linear16 channels=1/);
    const report = logger.lines.find((line) => line.includes('rms='));
    assert.match(report, /captured=1\.0s/);
    assert.match(report, /rms=-6\.0dBFS/);
    assert.match(report, /peak=-6\.0dBFS/);
    socket.close();
  });
});

// The failure this spike exists to catch: the graph is wired up and frames arrive,
// but Chrome is handing us digital silence.
test('distinguishes a silent tap from one carrying audio', async () => {
  await withBridge(async ({ bridge, port, logger }) => {
    const credentials = bridge.register('session-1');
    const socket = await openTap(port, 'session-1', credentials.token);
    socket.send(JSON.stringify({ type: 'hello', sampleRate: AUDIO_SAMPLE_RATE, channels: 1, encoding: 'linear16' }));
    socket.send(Buffer.alloc(AUDIO_SAMPLE_RATE * 2));

    await waitFor(() => logger.lines.some((line) => line.includes('rms=')));
    const report = logger.lines.find((line) => line.includes('rms='));
    assert.match(report, /rms=-infdBFS/);
    assert.match(report, /peak=-infdBFS/);
    socket.close();
  });
});

test('rejects a tap presenting the wrong token or an unknown session', async () => {
  await withBridge(async ({ bridge, port }) => {
    const credentials = bridge.register('session-1');

    for (const url of [
      `ws://127.0.0.1:${port}/?session=session-1&token=wrong-token`,
      `ws://127.0.0.1:${port}/?session=session-unknown&token=${credentials.token}`,
      `ws://127.0.0.1:${port}/?session=session-1`,
    ]) {
      const socket = new WebSocket(url);
      const code = await new Promise((resolve) => socket.once('close', resolve));
      assert.equal(code, 1008);
    }
  });
});

test('a relaunched runner supersedes the previous tap rather than doubling the stream', async () => {
  await withBridge(async ({ bridge, port }) => {
    const first = bridge.register('session-1');
    const firstSocket = await openTap(port, 'session-1', first.token);
    const closed = new Promise((resolve) => firstSocket.once('close', resolve));

    // A runner relaunch re-fetches bootstrap, which mints fresh credentials.
    const second = bridge.register('session-1');
    assert.notEqual(second.token, first.token);
    await closed;

    const secondSocket = await openTap(port, 'session-1', second.token);
    assert.equal(secondSocket.readyState, WebSocket.OPEN);
    secondSocket.close();
  });
});

test('unregistering a session closes its tap and refuses reconnection', async () => {
  await withBridge(async ({ bridge, port }) => {
    const credentials = bridge.register('session-1');
    const socket = await openTap(port, 'session-1', credentials.token);
    const closed = new Promise((resolve) => socket.once('close', resolve));

    bridge.unregister('session-1');
    await closed;

    const rejected = new WebSocket(`ws://127.0.0.1:${port}/?session=session-1&token=${credentials.token}`);
    assert.equal(await new Promise((resolve) => rejected.once('close', resolve)), 1008);
  });
});

test('register yields nothing while the bridge is stopped so the runner joins without media', async () => {
  const bridge = new AudioBridge(collectLogger());
  assert.equal(bridge.register('session-1'), undefined);
});
