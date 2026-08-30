'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const indexPath = require.resolve('./index.js');
const dependencyPaths = Object.fromEntries([
  'config', 'token', 'webhook-subscriptions', 'webhook-router', 'browser-runtime', 'orchestrator', 'meeting-minutes', 'api', 'transcription', 'webex-transcription', 'meeting-agent',
].map((name) => [name, require.resolve(`./${name}.js`)]));

function loadRegister(t, mocks) {
  const previous = new Map();
  for (const [name, path] of Object.entries(dependencyPaths)) {
    previous.set(path, require.cache[path]);
    require.cache[path] = { id: path, filename: path, loaded: true, exports: mocks[name] ?? {} };
  }
  delete require.cache[indexPath];
  const register = require('./index.js');
  t.after(() => {
    delete require.cache[indexPath];
    for (const [path, entry] of previous) {
      if (entry) require.cache[path] = entry;
      else delete require.cache[path];
    }
  });
  return register;
}

test('disables itself cleanly when required configuration is invalid', (t) => {
  const register = loadRegister(t, { config: { getConfig: () => { throw new Error('WEBEX_MEETING_TOKEN is required'); } } });
  const warnings = [];
  register({ logger: { warn: (message) => warnings.push(message) } });
  assert.deepEqual(warnings, ['[webex-meeting-join] disabled: WEBEX_MEETING_TOKEN is required']);
});

test('wires the lifecycle, recovery fallbacks, and shutdown cleanup through injected components', async (t) => {
  const originalSetInterval = global.setInterval;
  const originalClearInterval = global.clearInterval;
  let intervalCallback;
  global.setInterval = (callback) => { intervalCallback = callback; return 'refresh-timer'; };
  global.clearInterval = (timer) => assert.equal(timer, 'refresh-timer');
  t.after(() => { global.setInterval = originalSetInterval; global.clearInterval = originalClearInterval; });
  const calls = [];
  const cfg = {
    transcription: { enabled: false, provider: 'off' }, minutes: { enabled: true }, canRefreshMeetingToken: true,
    webhookSecret: 'secret', webhookBaseUrl: 'https://hooks.example', botToken: 'bot-token',
    joinTimeoutMs: 10_000, browserExecutablePath: '/browser',
  };
  const tokenStore = { getToken: () => 'meeting-token', refresh: async () => { calls.push('refresh'); if (calls.filter((x) => x === 'refresh').length > 1) throw new Error('refresh down'); } };
  const orchestrator = {
    handleMeetingStarted: async (payload) => calls.push(['started', payload]),
    handleMeetingEnded: async (payload) => calls.push(['ended', payload]),
    handleTranscriptCreated: async (payload) => calls.push(['transcript', payload]),
    handleMessageCreated: async (payload) => calls.push(['message', payload]),
    start: async () => { calls.push('start'); throw new Error('SDK unavailable'); },
    reconcile: async () => { calls.push('reconcile'); throw new Error('listing unavailable'); },
    startPolling: () => calls.push('poll'),
    dispose: async () => calls.push('dispose'),
  };
  const meetingMinutes = { resumePending: async () => { calls.push('resume'); throw new Error('disk unavailable'); } };
  const register = loadRegister(t, {
    config: { getConfig: () => cfg },
    token: { createTokenStore: () => tokenStore },
    'webhook-subscriptions': {
      ensureWebhooks: async (args) => calls.push(['ensure', args]),
      deregisterWebhooks: async () => { calls.push('deregister'); throw new Error('Webex unavailable'); },
    },
    'webhook-router': { ROUTE_PREFIX: '/webhooks/webex-meeting-join', createWebhookRouter: (args) => ({ routerArgs: args }) },
    'browser-runtime': { createBrowserRuntime: (args) => { calls.push(['browser', args]); return { runtime: true }; } },
    orchestrator: { createOrchestrator: (args) => { calls.push(['orchestrator', args]); return orchestrator; } },
    'meeting-minutes': { createMeetingMinutesManager: () => meetingMinutes },
    api: { webexFetch: async () => {} },
  });
  const events = new Map();
  let route;
  const logs = [];
  register({
    runtime: { id: 'runtime' }, logger: {
      info: (message) => logs.push(['info', message]), warn: (message) => logs.push(['warn', message]),
    },
    registerHttpRoute: (value) => { route = value; },
    on: (name, handler) => events.set(name, handler),
  });
  assert.equal(route.path, '/webhooks/webex-meeting-join/');
  assert.equal(route.auth, 'plugin');
  assert.deepEqual([...route.handler.routerArgs.handlers.keys()], ['/meetings-started', '/meetings-ended', '/transcripts-created', '/messages-created']);

  await events.get('gateway_start')();
  await intervalCallback();
  await events.get('gateway_stop')();
  assert.ok(calls.includes('poll'));
  assert.ok(calls.includes('dispose'));
  assert.ok(calls.includes('deregister'));
  assert.equal(calls.filter((x) => x === 'refresh').length, 2);
  assert.ok(logs.some(([, message]) => /initial setup failed/.test(message)));
  assert.ok(logs.some(([, message]) => /startup reconciliation failed/.test(message)));
  assert.ok(logs.some(([, message]) => /failed to resume transcript recovery jobs/.test(message)));
  assert.ok(logs.some(([, message]) => /scheduled token refresh failed/.test(message)));
  assert.ok(logs.some(([, message]) => /webhook deregister failed/.test(message)));
});

test('enables live transcription and routes browser PCM frames to its session manager', (t) => {
  const cfg = {
    transcription: { enabled: true, provider: 'deepgram', apiKey: 'key', baseUrl: 'https://deepgram.example', model: 'flux', sampleRate: 16000, eotThreshold: 0.7, eotTimeoutMs: 800, gateThreshold: 0.8, addressedGateThreshold: 0.5, minTurnWords: 3 },
    minutes: { enabled: false }, canRefreshMeetingToken: false, botToken: 'bot', webhookBaseUrl: 'https://hooks.example', webhookSecret: null,
  };
  let browserOptions;
  let transcriptionOptions;
  const register = loadRegister(t, {
    config: { getConfig: () => cfg }, token: { createTokenStore: () => ({ getToken: () => 'meeting' }) },
    'webhook-subscriptions': { ensureWebhooks: async () => {}, deregisterWebhooks: async () => {} },
    'webhook-router': { ROUTE_PREFIX: '/hooks', createWebhookRouter: () => () => {} },
    'browser-runtime': { createBrowserRuntime: (options) => { browserOptions = options; return {}; } },
    orchestrator: { createOrchestrator: () => ({}) },
    'meeting-minutes': { createMeetingMinutesManager: () => { throw new Error('minutes should be disabled'); } },
    api: { webexFetch: async () => {} },
    transcription: { createTranscriptionManager: (options) => { transcriptionOptions = options; return { pushPcm: (...args) => { transcriptionOptions.pushed = args; } }; } },
    'meeting-agent': { createMeetingAgent: () => ({ handleTurn: () => {} }) },
  });
  register({ runtime: {}, logger: { info() {} }, registerHttpRoute() {}, on() {} });
  browserOptions.onAudioData('sdk-id', 'pcm');
  assert.deepEqual(transcriptionOptions.pushed, ['sdk-id', 'pcm']);
  assert.equal(transcriptionOptions.model, 'flux');
  assert.equal(browserOptions.onAudioData instanceof Function, true);
  assert.equal(browserOptions.onCaptions, null);
});

test('routes Webex captions without exposing the Deepgram PCM bridge', (t) => {
  const cfg = {
    transcription: { enabled: true, provider: 'webex', gateThreshold: 0.8, addressedGateThreshold: 0.5, minTurnWords: 3 },
    minutes: { enabled: false }, canRefreshMeetingToken: false, botToken: 'bot', webhookBaseUrl: 'https://hooks.example', webhookSecret: null,
  };
  let browserOptions;
  let pushed;
  const register = loadRegister(t, {
    config: { getConfig: () => cfg }, token: { createTokenStore: () => ({ getToken: () => 'meeting' }) },
    'webhook-subscriptions': { ensureWebhooks: async () => {}, deregisterWebhooks: async () => {} },
    'webhook-router': { ROUTE_PREFIX: '/hooks', createWebhookRouter: () => () => {} },
    'browser-runtime': { createBrowserRuntime: (options) => { browserOptions = options; return {}; } },
    orchestrator: { createOrchestrator: () => ({}) },
    'meeting-minutes': { createMeetingMinutesManager: () => {} },
    api: { webexFetch: async () => {} },
    'webex-transcription': { createWebexTranscriptionManager: () => ({ pushCaptions: (...args) => { pushed = args; } }) },
    'meeting-agent': { createMeetingAgent: () => ({ handleTurn: () => {} }) },
  });
  register({ runtime: {}, logger: { info() {} }, registerHttpRoute() {}, on() {} });
  browserOptions.onCaptions('sdk-id', { captions: [] });
  assert.deepEqual(pushed, ['sdk-id', { captions: [] }]);
  assert.equal(browserOptions.onAudioData, null);
});
