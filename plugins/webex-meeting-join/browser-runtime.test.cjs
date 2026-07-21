'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { createBrowserRuntime, RUNTIME_ORIGIN } = require('./browser-runtime');

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function makeHarness(behavior = async () => undefined, { log } = {}) {
  const pages = [];
  let launchCalls = 0;
  const browser = {
    connected: true,
    closed: false,
    isConnected() { return this.connected; },
    async newPage() {
      const page = {
        closed: false,
        calls: [],
        isClosed() { return this.closed; },
        async route(pattern, handler) {
          this.routePattern = pattern;
          this.routeHandler = handler;
        },
        async goto(url) { this.gotoUrl = url; },
        async addScriptTag() {},
        async evaluate(fn, arg) {
          const method = fn.toString().match(/__webexMeetingJoin\.(\w+)/)?.[1];
          this.calls.push({ method, arg });
          return behavior(method, arg, this, pages.length);
        },
        async close() { this.closed = true; },
      };
      pages.push(page);
      return page;
    },
    async close() {
      this.closed = true;
      this.connected = false;
    },
  };
  const runtime = createBrowserRuntime({
    log,
    joinTimeoutMs: 100,
    launchChromium: async () => {
      launchCalls += 1;
      return browser;
    },
    loadBundle: async () => '/* fake bundle */',
  });
  return { runtime, browser, pages, get launchCalls() { return launchCalls; } };
}

test('init is idempotent and updates a refreshed token in the existing SDK instance', async () => {
  const harness = makeHarness(async (method) => method === 'join' ? 'sdk-meeting-id' : undefined);

  await harness.runtime.init('token-1');
  await harness.runtime.init('token-1');
  await harness.runtime.init('token-2');
  const sdkId = await harness.runtime.join('sip:test@example.com', 'SIP_URI');

  assert.equal(harness.launchCalls, 1);
  assert.equal(harness.pages.length, 1);
  assert.equal(sdkId, 'sdk-meeting-id');
  assert.equal(harness.pages[0].routePattern, `${RUNTIME_ORIGIN}/**`);
  assert.equal(harness.pages[0].gotoUrl, `${RUNTIME_ORIGIN}/`);
  assert.deepEqual(
    harness.pages[0].calls.map(({ method, arg }) => ({ method, arg })),
    [
      { method: 'init', arg: 'token-1' },
      { method: 'updateAccessToken', arg: 'token-2' },
      { method: 'join', arg: { d: 'sip:test@example.com', t: 'SIP_URI' } },
    ]
  );
});

test('join accepts a device-confirmed Locus success after an SDK response failure', async () => {
  const warnings = [];
  const harness = makeHarness(async (method) => method === 'join'
    ? { meetingId: 'sdk-meeting-id', recovered: true, diagnostic: 'JoinMeetingError — code 2' }
    : undefined, { log: { warn: (message) => warnings.push(message) } });

  await harness.runtime.init('token-1');
  const sdkId = await harness.runtime.join('https://example.webex.com/meet/test', 'MEETING_LINK');

  assert.equal(sdkId, 'sdk-meeting-id');
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /Locus confirmed this device joined/);
});

test('a failed SDK initialization discards the partial page before retrying', async () => {
  let initCalls = 0;
  const harness = makeHarness(async (method) => {
    if (method === 'init' && ++initCalls === 1) throw new Error('device registration failed');
  });

  await assert.rejects(harness.runtime.init('token-1'), /device registration failed/);
  assert.equal(harness.pages[0].closed, true);

  await harness.runtime.init('token-1');
  assert.equal(harness.pages.length, 2);
  assert.equal(harness.pages[1].closed, false);
});

test('concurrent initialization is coalesced and a racing token refresh is applied', async () => {
  const gate = deferred();
  let initCalls = 0;
  const harness = makeHarness(async (method) => {
    if (method === 'init') {
      initCalls += 1;
      await gate.promise;
    }
  });

  const first = harness.runtime.init('token-1');
  const second = harness.runtime.init('token-2');
  await new Promise((resolve) => setImmediate(resolve));
  gate.resolve();
  await Promise.all([first, second]);

  assert.equal(harness.launchCalls, 1);
  assert.equal(harness.pages.length, 1);
  assert.equal(initCalls, 1);
  assert.deepEqual(harness.pages[0].calls.map((call) => call.method), ['init', 'updateAccessToken']);
});

test('leave forwards stable REST, SDK, and destination identifiers to the page', async () => {
  const harness = makeHarness();
  const reference = {
    meetingId: 'rest-id',
    sdkMeetingId: 'sdk-id',
    destination: 'sip:test@example.com',
  };

  await harness.runtime.init('token-1');
  await harness.runtime.leave(reference);

  assert.deepEqual(harness.pages[0].calls.at(-1), { method: 'leave', arg: reference });
});
