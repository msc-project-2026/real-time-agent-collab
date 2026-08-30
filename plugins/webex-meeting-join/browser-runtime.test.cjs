'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  createBrowserRuntime,
  assertLocusLeaveRequest,
  resolveExecutablePath,
  BRAVE_EXECUTABLE_CANDIDATES,
  RUNTIME_ORIGIN,
} = require('./browser-runtime');

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function makeHarness(behavior = async () => undefined, { log, fetchImpl, onAudioData, onCaptions } = {}) {
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
        exposed: {},
        isClosed() { return this.closed; },
        async route(pattern, handler) {
          this.routePattern = pattern;
          this.routeHandler = handler;
        },
        async goto(url) { this.gotoUrl = url; },
        async addScriptTag() {},
        async exposeFunction(name, fn) { this.exposed[name] = fn; },
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
    fetchImpl,
    onAudioData,
    onCaptions,
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
  const requests = [];
  const leaveRequest = {
    url: 'https://locus-k.wbx2.com/locus/api/v1/loci/locus-id/participant/self-id/leave',
    method: 'PUT',
    headers: { authorization: 'Bearer token-1', 'content-type': 'application/json' },
    body: '{"correlationId":"correlation-id"}',
  };
  const harness = makeHarness(async (method) => method === 'leave' ? leaveRequest : undefined, {
    fetchImpl: async (...args) => {
      requests.push(args);
      return { ok: true, status: 200 };
    },
  });
  const reference = {
    meetingId: 'rest-id',
    sdkMeetingId: 'sdk-id',
    destination: 'sip:test@example.com',
  };

  await harness.runtime.init('token-1');
  await harness.runtime.leave(reference);

  assert.deepEqual(harness.pages[0].calls.slice(-2), [
    { method: 'leave', arg: reference },
    { method: 'confirmLeft', arg: reference },
  ]);
  assert.deepEqual(requests, [[leaveRequest.url, {
    method: 'PUT',
    headers: leaveRequest.headers,
    body: leaveRequest.body,
  }]]);
});

test('leave reports the actual Locus HTTP error returned outside browser CORS', async () => {
  const leaveRequest = {
    url: 'https://locus-k.wbx2.com/locus/api/v1/loci/locus-id/participant/self-id/leave',
    method: 'PUT',
    headers: {},
    body: '{}',
  };
  const harness = makeHarness(async (method) => method === 'leave' ? leaveRequest : undefined, {
    fetchImpl: async () => ({
      ok: false,
      status: 403,
      async text() { return '{"message":"participant cannot leave"}'; },
    }),
  });

  await harness.runtime.init('token-1');
  await assert.rejects(
    harness.runtime.leave({ meetingId: 'rest-id' }),
    /Webex Locus leave failed with HTTP 403: participant cannot leave/
  );
  assert.equal(harness.pages[0].calls.at(-1).method, 'leave');
});

test('an explicitly configured browser executable wins and must exist', () => {
  assert.equal(
    resolveExecutablePath({
      configuredPath: '/custom/chromium',
      fileExists: (p) => p === '/custom/chromium',
    }),
    '/custom/chromium'
  );
  assert.throws(
    () => resolveExecutablePath({ configuredPath: '/missing/browser', fileExists: () => false }),
    /WEBEX_MEETING_BROWSER_EXECUTABLE not found: \/missing\/browser/
  );
});

test('without configuration, Brave is auto-detected in candidate order', () => {
  const brave = BRAVE_EXECUTABLE_CANDIDATES[1];
  assert.equal(
    resolveExecutablePath({ fileExists: (p) => p === brave }),
    brave
  );
  // Earlier candidates take precedence when several exist.
  assert.equal(
    resolveExecutablePath({ fileExists: () => true }),
    BRAVE_EXECUTABLE_CANDIDATES[0]
  );
});

test('with no H264-capable browser, falls back to bundled Chromium with a warning', () => {
  const warnings = [];
  assert.equal(
    resolveExecutablePath({ fileExists: () => false, log: { warn: (m) => warnings.push(m) } }),
    undefined
  );
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /no H264-capable browser found/);
  assert.match(warnings[0], /audio subscription will fail/);
});

test('the audio PCM binding is exposed and routes frames to onAudioData only when configured', async () => {
  const frames = [];
  const withAudio = makeHarness(async () => undefined, { onAudioData: (id, b64) => frames.push({ id, b64 }) });
  await withAudio.runtime.init('token-1');
  const page = withAudio.pages[0];
  assert.equal(typeof page.exposed.__openclawMeetingAudioLog, 'function', 'log binding always exposed');
  assert.equal(typeof page.exposed.__openclawMeetingAudioPcm, 'function', 'PCM binding exposed when consumer wired');

  page.exposed.__openclawMeetingAudioPcm('sdk-1', 'AAECAw==');
  assert.deepEqual(frames, [{ id: 'sdk-1', b64: 'AAECAw==' }]);

  // With no consumer, the PCM binding is not exposed at all (no audio leaves the page).
  const noAudio = makeHarness(async () => undefined);
  await noAudio.runtime.init('token-1');
  assert.equal(noAudio.pages[0].exposed.__openclawMeetingAudioPcm, undefined);
});

test('Webex caption binding and transcription controls cross the browser boundary', async () => {
  const captions = [];
  const harness = makeHarness(async () => undefined, {
    onCaptions: (id, payload) => captions.push({ id, payload }),
  });
  await harness.runtime.init('token-1');
  const page = harness.pages[0];
  page.exposed.__openclawMeetingCaptions('sdk-1', { captions: [{ text: 'Hello' }] });
  await harness.runtime.startTranscription({ sdkMeetingId: 'sdk-1' });
  await harness.runtime.stopTranscription({ sdkMeetingId: 'sdk-1' });

  assert.deepEqual(captions, [{ id: 'sdk-1', payload: { captions: [{ text: 'Hello' }] } }]);
  assert.deepEqual(page.calls.slice(-2), [
    { method: 'startTranscription', arg: { sdkMeetingId: 'sdk-1' } },
    { method: 'stopTranscription', arg: { sdkMeetingId: 'sdk-1' } },
  ]);
  assert.equal(page.exposed.__openclawMeetingAudioPcm, undefined);
});

test('an injected executablePath is forwarded to the browser launcher', async () => {
  let launchOptions = null;
  const runtime = createBrowserRuntime({
    joinTimeoutMs: 100,
    executablePath: '/usr/bin/brave-browser',
    launchChromium: async (options) => {
      launchOptions = options;
      return {
        isConnected: () => true,
        async newPage() {
          return {
            isClosed: () => false,
            async route() {},
            async goto() {},
            async addScriptTag() {},
            async evaluate() {},
            async close() {},
          };
        },
        async close() {},
      };
    },
    loadBundle: async () => '/* fake bundle */',
  });

  await runtime.init('token-1');
  assert.equal(launchOptions.executablePath, '/usr/bin/brave-browser');
  assert.ok(launchOptions.args.includes('--autoplay-policy=no-user-gesture-required'));
});

test('Locus leave request validation rejects non-leave and non-HTTPS endpoints', () => {
  assert.equal(
    assertLocusLeaveRequest({
      url: 'https://locus-k.wbx2.com/locus/api/v1/loci/locus-id/participant/self-id/leave',
      method: 'PUT',
    }),
    'https://locus-k.wbx2.com/locus/api/v1/loci/locus-id/participant/self-id/leave'
  );
  assert.throws(
    () => assertLocusLeaveRequest({ url: 'http://127.0.0.1/locus/api/v1/loci/a/participant/b/leave', method: 'PUT' }),
    /unexpected Locus leave endpoint/
  );
  assert.throws(
    () => assertLocusLeaveRequest({ url: 'https://locus-k.wbx2.com/other', method: 'PUT' }),
    /unexpected Locus leave endpoint/
  );
  assert.throws(
    () => assertLocusLeaveRequest({
      url: 'https://example.com/locus/api/v1/loci/a/participant/b/leave',
      method: 'PUT',
    }),
    /unexpected Locus leave endpoint/
  );
});
