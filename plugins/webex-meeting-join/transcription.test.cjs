'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { createTranscriptionManager } = require('./transcription');

// Fake Deepgram socket capturing the createConnection args, event handlers, and
// media sent. Mirrors the real listen.v2 socket surface the manager uses.
function makeFakeDeepgram() {
  const sockets = [];
  const client = {
    listen: {
      v2: {
        async createConnection(args) {
          const handlers = {};
          const socket = {
            args,
            sent: [],
            connected: false,
            closed: false,
            closeStreamSent: false,
            on(event, cb) { handlers[event] = cb; },
            connect() { this.connected = true; },
            emit(event, data) { handlers[event]?.(data); },
            sendMedia(buf) { this.sent.push(buf); },
            sendCloseStream() { this.closeStreamSent = true; },
            close() { this.closed = true; },
          };
          sockets.push(socket);
          return socket;
        },
      },
    },
  };
  return { client, sockets };
}

const baseCfg = (overrides = {}) => ({
  apiKey: 'dg-key',
  model: 'flux-general-en',
  sampleRate: 16000,
  eotThreshold: 0.7,
  eotTimeoutMs: 5000,
  ...overrides,
});

test('startSession opens a Deepgram connection with the configured Flux params', async () => {
  const { client, sockets } = makeFakeDeepgram();
  const mgr = createTranscriptionManager({ ...baseCfg(), deepgramFactory: () => client, onTurn: () => {} });

  mgr.startSession({ sdkMeetingId: 'sdk-1', roomId: 'room-1', meetingId: 'm-1' });
  await new Promise((r) => setImmediate(r)); // let openSocket's await resolve

  assert.equal(sockets.length, 1);
  assert.deepEqual(sockets[0].args, {
    model: 'flux-general-en',
    eot_threshold: 0.7,
    eot_timeout_ms: 5000,
    encoding: 'linear16',
    sample_rate: 16000,
  });
  assert.equal(sockets[0].connected, true);
});

test('PCM is buffered before open, then flushed in order once open', async () => {
  const { client, sockets } = makeFakeDeepgram();
  const mgr = createTranscriptionManager({ ...baseCfg(), deepgramFactory: () => client, onTurn: () => {} });

  mgr.startSession({ sdkMeetingId: 'sdk-1', roomId: 'room-1', meetingId: 'm-1' });
  await new Promise((r) => setImmediate(r));

  const a = Buffer.from([1, 2]).toString('base64');
  const b = Buffer.from([3, 4]).toString('base64');
  mgr.pushPcm('sdk-1', a); // before 'open'
  mgr.pushPcm('sdk-1', b);
  assert.equal(sockets[0].sent.length, 0, 'nothing sent before open');

  sockets[0].emit('open');
  assert.equal(sockets[0].sent.length, 2, 'backlog flushed on open');
  assert.deepEqual([...sockets[0].sent[0]], [1, 2]);
  assert.deepEqual([...sockets[0].sent[1]], [3, 4]);

  // After open, PCM is sent straight through.
  mgr.pushPcm('sdk-1', Buffer.from([5]).toString('base64'));
  assert.deepEqual([...sockets[0].sent[2]], [5]);
});

test('an EndOfTurn transcript is emitted; other events and empty transcripts are ignored', async () => {
  const { client, sockets } = makeFakeDeepgram();
  const turns = [];
  const mgr = createTranscriptionManager({ ...baseCfg(), deepgramFactory: () => client, onTurn: (t) => turns.push(t) });

  mgr.startSession({ sdkMeetingId: 'sdk-1', roomId: 'room-1', meetingId: 'm-1' });
  await new Promise((r) => setImmediate(r));

  sockets[0].emit('message', { event: 'StartOfTurn', turn_index: 0 });
  sockets[0].emit('message', { event: 'EndOfTurn', transcript: '   ', turn_index: 0 }); // empty → ignored
  sockets[0].emit('message', { event: 'EagerEndOfTurn', transcript: 'not final', turn_index: 1 });
  sockets[0].emit('message', { event: 'EndOfTurn', transcript: 'the API returns 404 there', turn_index: 1, end_of_turn_confidence: 0.9 });

  assert.equal(turns.length, 1);
  assert.deepEqual(turns[0], {
    sdkMeetingId: 'sdk-1',
    roomId: 'room-1',
    meetingId: 'm-1',
    transcript: 'the API returns 404 there',
    turnIndex: 1,
    confidence: 0.9,
  });
});

test('endSession sends CloseStream, closes the socket, and stops routing PCM', async () => {
  const { client, sockets } = makeFakeDeepgram();
  const mgr = createTranscriptionManager({ ...baseCfg(), deepgramFactory: () => client, onTurn: () => {} });

  mgr.startSession({ sdkMeetingId: 'sdk-1', roomId: 'room-1', meetingId: 'm-1' });
  await new Promise((r) => setImmediate(r));
  sockets[0].emit('open');

  mgr.endSession('sdk-1');
  assert.equal(sockets[0].closeStreamSent, true);
  assert.equal(sockets[0].closed, true);

  const before = sockets[0].sent.length;
  mgr.pushPcm('sdk-1', Buffer.from([9]).toString('base64')); // session gone → dropped
  assert.equal(sockets[0].sent.length, before);
});

test('baseUrl (when configured) is passed through to the Deepgram client factory', async () => {
  const { client } = makeFakeDeepgram();
  const factoryArgs = [];
  const mgr = createTranscriptionManager({
    ...baseCfg({ baseUrl: 'https://api.deepgram.com' }),
    deepgramFactory: (apiKey, baseUrl) => { factoryArgs.push({ apiKey, baseUrl }); return client; },
    onTurn: () => {},
  });
  mgr.startSession({ sdkMeetingId: 'sdk-1', roomId: 'room-1', meetingId: 'm-1' });
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(factoryArgs, [{ apiKey: 'dg-key', baseUrl: 'https://api.deepgram.com' }]);
});

test('startSession is idempotent and PCM for an unknown meeting is dropped', async () => {
  const { client, sockets } = makeFakeDeepgram();
  const mgr = createTranscriptionManager({ ...baseCfg(), deepgramFactory: () => client, onTurn: () => {} });

  mgr.startSession({ sdkMeetingId: 'sdk-1', roomId: 'room-1', meetingId: 'm-1' });
  mgr.startSession({ sdkMeetingId: 'sdk-1', roomId: 'room-1', meetingId: 'm-1' });
  await new Promise((r) => setImmediate(r));
  assert.equal(sockets.length, 1, 'second startSession is a no-op');

  // Unknown meeting: must not throw.
  mgr.pushPcm('sdk-unknown', Buffer.from([1]).toString('base64'));
});
