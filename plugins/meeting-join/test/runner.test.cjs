'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { readFile } = require('node:fs/promises');
const path = require('node:path');
const vm = require('node:vm');

async function loadRunner({ enterLobby = false, autoStart = false } = {}) {
  const source = await readFile(path.join(__dirname, '../dist/runner.js'), 'utf8');
  const events = [];
  const listeners = new Map();
  let click;
  let initOptions;

  const button = {
    disabled: false,
    addEventListener(type, handler) {
      if (type === 'click') click = handler;
    },
  };
  const status = { textContent: '' };
  const meeting = {
    passwordStatus: 'NOT_REQUIRED',
    on(name, handler) { listeners.set(name, handler); },
    async join() {
      if (enterLobby) listeners.get('meeting:self:lobbyWaiting')?.();
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
      location: { pathname: '/meeting-join/runner/session-1' },
      Webex: { init(options) { initOptions = options; return webex; } },
    },
    document: {
      body: { dataset: { autostart: String(autoStart) } },
      querySelector(selector) {
        if (selector === '#join-meeting') return button;
        if (selector === '#meeting-status') return status;
        return null;
      },
    },
    fetch: async (url, init = {}) => {
      if (String(url).endsWith('/bootstrap')) {
        return { ok: true, json: async () => ({ accessToken: 'human-oauth-token', joinLink: 'https://example.webex.com/meet/test', password: 'pw' }) };
      }
      if (String(url).endsWith('/events')) events.push(JSON.parse(init.body));
      return { ok: true, json: async () => ({}) };
    },
    Request: class Request {},
    setInterval() { return 1; },
    clearInterval() {},
    queueMicrotask,
    console,
  };
  context.window.window = context.window;
  vm.runInNewContext(source, context);

  async function settle() {
    for (let i = 0; i < 6; i += 1) await new Promise((resolve) => setImmediate(resolve));
  }

  return {
    get initOptions() { return initOptions; },
    events,
    button,
    status,
    click: async () => { click(); await settle(); },
  };
}

test('waits for an agent-selected browser action and initializes Webex with the OAuth access token', async () => {
  const runner = await loadRunner();
  assert.equal(runner.initOptions, undefined);
  assert.equal(runner.button.disabled, false);

  await runner.click();

  assert.equal(runner.initOptions.credentials.access_token, 'human-oauth-token');
  assert.equal(runner.initOptions.appName, 'openclaw-meeting-join');
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
