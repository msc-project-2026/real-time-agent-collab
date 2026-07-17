'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { readFile } = require('node:fs/promises');
const path = require('node:path');
const vm = require('node:vm');

// Minimal Web Audio / WebSocket surface for the meeting audio tap. Only the calls the
// tap actually makes are modelled; anything else should fail loudly rather than pass.
function audioTapMocks() {
  const state = { sent: [], sink: null, tapKind: null, socketUrl: null };

  class FakeWebSocket {
    static OPEN = 1;
    constructor(url) {
      state.socketUrl = url;
      this.readyState = FakeWebSocket.OPEN;
      this.bufferedAmount = 0;
      setImmediate(() => this.onOpen?.());
    }
    addEventListener(type, handler) { if (type === 'open') this.onOpen = handler; }
    send(data) { state.sent.push(data); }
    close() { this.readyState = 3; }
  }

  class FakeAudioWorkletNode {
    constructor() { this.port = { onmessage: null }; state.tapKind = 'worklet'; }
    connect() {}
  }

  class FakeAudioContext {
    constructor(options) {
      this.sampleRate = options?.sampleRate ?? 48_000;
      this.state = 'running';
      this.destination = {};
      this.audioWorklet = { addModule: async () => {} };
    }
    async resume() { this.state = 'running'; }
    async close() {}
    createMediaStreamSource() { return { connect() {} }; }
    createGain() { return { gain: {}, connect() {} }; }
    createScriptProcessor() { state.tapKind = 'script-processor'; return { connect() {} }; }
  }

  return {
    state,
    globals: {
      WebSocket: FakeWebSocket,
      AudioContext: FakeAudioContext,
      AudioWorkletNode: FakeAudioWorkletNode,
      Blob: class Blob {},
      URL: { createObjectURL: () => 'blob:worklet', revokeObjectURL() {} },
    },
    createElement: () => (state.sink = { setAttribute() {}, play: async () => {} }),
  };
}

async function loadRunner({ enterLobby = false, autoStart = false, passwordRequired = false, includePassword = true, joinError, audioTap, addMediaError, addMediaErrorOnce = false } = {}) {
  const source = await readFile(path.join(__dirname, '../dist/runner.js'), 'utf8');
  const events = [];
  const listeners = new Map();
  const audio = audioTapMocks();
  let click;
  let initOptions;
  let addMediaOptions;

  const button = {
    disabled: false,
    addEventListener(type, handler) {
      if (type === 'click') click = handler;
    },
  };
  const status = { textContent: '' };
  const meeting = {
    passwordStatus: passwordRequired ? 'REQUIRED' : 'NOT_REQUIRED',
    on(name, handler) { listeners.set(name, handler); },
    once(name, handler) { listeners.set(name, handler); },
    async verifyPassword() { return { isPasswordValid: true }; },
    async join() {
      if (joinError) throw joinError;
      if (enterLobby) listeners.get('meeting:self:lobbyWaiting')?.();
    },
    async addMedia(options) {
      // Copy out of the VM realm: deepEqual compares prototypes, and objects built
      // inside the context do not share the host's.
      addMediaOptions = JSON.parse(JSON.stringify(options));
      if (addMediaError) {
        const error = addMediaError;
        if (addMediaErrorOnce) addMediaError = undefined;
        throw error;
      }
      listeners.get('media:ready')?.({ type: 'remoteAudio', stream: { id: 'remote-audio' } });
    },
  };
  const webex = {
    once(name, handler) {
      if (name === 'ready') queueMicrotask(handler);
    },
    meetings: {
      async register() {},
      async create() { return meeting; },
    },
  };

  const context = {
    window: {
      location: { pathname: '/webex-auto-join/runner/session-1' },
      Webex: { init(options) { initOptions = options; return webex; } },
    },
    document: {
      body: { dataset: { autostart: String(autoStart) }, appendChild() {} },
      createElement: audio.createElement,
      querySelector(selector) {
        if (selector === '#join-meeting') return button;
        if (selector === '#meeting-status') return status;
        return null;
      },
    },
    fetch: async (url, init = {}) => {
      if (String(url).endsWith('/bootstrap')) {
        return { ok: true, json: async () => ({
          accessToken: 'human-oauth-token',
          destination: 'meeting-id',
          joinLink: 'https://example.webex.com/meet/test',
          sessionId: 'session-1',
          ...(includePassword ? { password: 'pw' } : {}),
          ...(audioTap ? { audioTap } : {}),
        }) };
      }
      if (String(url).endsWith('/events')) events.push(JSON.parse(init.body));
      return { ok: true, json: async () => ({}) };
    },
    Request: class Request {},
    setInterval() { return 1; },
    clearInterval() {},
    setTimeout,
    clearTimeout,
    setImmediate,
    queueMicrotask,
    console,
    ...audio.globals,
  };
  context.window.window = context.window;
  vm.runInNewContext(source, context);

  async function settle() {
    for (let i = 0; i < 6; i += 1) await new Promise((resolve) => setImmediate(resolve));
  }

  return {
    get initOptions() { return initOptions; },
    get addMediaOptions() { return addMediaOptions; },
    audio: audio.state,
    events,
    button,
    status,
    admit: async () => { listeners.get('meeting:self:guestAdmitted')?.(); await settle(); },
    click: async () => { click(); await settle(); },
  };
}

test('waits for an agent-selected browser action and initializes Webex with the OAuth access token', async () => {
  const runner = await loadRunner();
  assert.equal(runner.initOptions, undefined);
  assert.equal(runner.button.disabled, false);

  await runner.click();

  assert.equal(runner.initOptions.credentials.access_token, 'human-oauth-token');
  assert.equal(runner.initOptions.appName, 'openclaw-webex-auto-join');
  assert.deepEqual(runner.events.map((event) => event.type), ['joining', 'joined']);
  assert.equal(runner.status.textContent, 'Joined the Webex meeting.');
});

test('does not report joined while the Webex user is waiting in the lobby', async () => {
  const runner = await loadRunner({ enterLobby: true });
  await runner.click();

  assert.deepEqual(runner.events.map((event) => event.type), ['joining', 'waiting_for_admission']);
  assert.equal(runner.status.textContent, 'Waiting for the host to admit this Webex user.');
});

test('auto-start mode joins without an agent browser action or targetId handoff', async () => {
  const runner = await loadRunner({ autoStart: true });
  for (let i = 0; i < 6; i += 1) await new Promise((resolve) => setImmediate(resolve));

  assert.equal(runner.initOptions.credentials.access_token, 'human-oauth-token');
  assert.deepEqual(runner.events.map((event) => event.type), ['joining', 'joined']);
  assert.equal(runner.status.textContent, 'Joined the Webex meeting.');
});

test('passwordless discovery only fails when the SDK reports a required password', async () => {
  const runner = await loadRunner({ passwordRequired: true, includePassword: false });
  await runner.click();

  assert.deepEqual(runner.events.map((event) => event.type), ['joining', 'error']);
  assert.equal(runner.events[1].code, 'meeting_password_required');
});

test('reports a sanitized stage, SDK code, and message for join failures', async () => {
  const error = Object.assign(new Error('Join rejected at https://example.webex.com/x access_token=top-secret-value'), { code: 30105 });
  const runner = await loadRunner({ joinError: error });
  await runner.click();

  const failure = runner.events.find((event) => event.type === 'error');
  assert.equal(failure.code, 'meeting_join_failed');
  assert.match(failure.detail, /stage=meeting_join/);
  assert.match(failure.detail, /sdk_code=30105/);
  assert.match(failure.detail, /\[redacted-url\]/);
  assert.doesNotMatch(failure.detail, /top-secret-value|example\.webex\.com/);
});

const AUDIO_TAP = { port: 41234, token: 'tap-token', sampleRate: 16000 };

test('the audio tap receives remote audio without publishing any local media', async () => {
  const runner = await loadRunner({ audioTap: AUDIO_TAP });
  await runner.click();

  // The SDK defaults every one of these to true when omitted, so a receive-only bot
  // has to name them or it starts publishing video and share.
  assert.deepEqual(runner.addMediaOptions, {
    localStreams: {},
    audioEnabled: true,
    videoEnabled: false,
    shareAudioEnabled: false,
    shareVideoEnabled: false,
  });
  const notice = runner.events.find((event) => event.type === 'audio_tap');
  assert.equal(notice.code, 'started');
  assert.match(notice.detail, /rate=16000 state=running tap=worklet/);
  assert.equal(runner.status.textContent, 'Joined the Webex meeting.');
});

test('the tap announces its format to the bridge behind the session token', async () => {
  const runner = await loadRunner({ audioTap: AUDIO_TAP });
  await runner.click();

  assert.equal(runner.audio.socketUrl, 'ws://127.0.0.1:41234/?session=session-1&token=tap-token');
  assert.deepEqual(JSON.parse(runner.audio.sent[0]), {
    type: 'hello',
    sessionId: 'session-1',
    sampleRate: 16000,
    channels: 1,
    encoding: 'linear16',
  });
});

test('a failing audio tap leaves the meeting join healthy', async () => {
  const runner = await loadRunner({ audioTap: AUDIO_TAP, addMediaError: new Error('media negotiation failed') });
  await runner.click();

  // Advisory, never 'error': an error event trips the service into a recovery relaunch
  // or a hard failure, over a tap the meeting itself does not depend on.
  assert.deepEqual(runner.events.map((event) => event.type), ['joining', 'audio_tap', 'joined']);
  const notice = runner.events.find((event) => event.type === 'audio_tap');
  assert.equal(notice.code, 'failed');
  assert.match(notice.detail, /media negotiation failed/);
  assert.equal(runner.status.textContent, 'Joined the Webex meeting.');
});

test('a lobby admission retries the tap that addMedia refused while waiting', async () => {
  const runner = await loadRunner({
    audioTap: AUDIO_TAP,
    enterLobby: true,
    addMediaError: new Error('not admitted yet'),
    addMediaErrorOnce: true,
  });
  await runner.click();
  assert.equal(runner.events.find((event) => event.type === 'audio_tap').code, 'failed');

  await runner.admit();

  assert.deepEqual(runner.events.filter((event) => event.type === 'audio_tap').map((event) => event.code), ['failed', 'started']);
});

test('a runner given no audio bridge joins without adding media', async () => {
  const runner = await loadRunner();
  await runner.click();

  assert.equal(runner.addMediaOptions, undefined);
  assert.equal(runner.audio.socketUrl, null);
  assert.deepEqual(runner.events.map((event) => event.type), ['joining', 'joined']);
});

test('unwraps the nested SDK cause so the real join reason surfaces', async () => {
  // Mirrors Webex JoinMeetingError: generic code 2 wrapper with the true cause on `.error`.
  const cause = Object.assign(new Error('Meeting is not active'), {
    name: 'LocusError',
    statusCode: 403,
    body: { errorCode: 2409005, message: 'Meeting is not active' },
  });
  const error = Object.assign(new Error('Error Joining Meeting'), {
    name: 'JoinMeetingError',
    code: 2,
    sdkMessage: 'There was an issue joining the meeting, meeting could be in a bad state.',
    error: cause,
  });
  const runner = await loadRunner({ joinError: error });
  await runner.click();

  const failure = runner.events.find((event) => event.type === 'error');
  assert.equal(failure.code, 'meeting_join_failed');
  assert.match(failure.detail, /sdk_code=2/);
  assert.match(failure.detail, /sdk_message=There was an issue joining/);
  assert.match(failure.detail, /cause1_name=LocusError/);
  assert.match(failure.detail, /cause1_code=403/);
  assert.match(failure.detail, /cause1_message=Meeting is not active/);
});
