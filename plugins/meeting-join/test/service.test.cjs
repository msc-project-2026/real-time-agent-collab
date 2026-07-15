'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { mkdtemp, readFile, rm } = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const {
  BrowserControl,
  BrowserControlError,
  browserActionFailure,
  createInvitation,
  EncryptedState,
  MeetingJoinService,
  safeErrorCode,
  snapshotRefs,
} = require('../dist/service.cjs');

const JOIN_LINK = 'https://meet1753491728593-7008.webex.com/meet1753491728593-7008/j.php?MTID=m0ceda7e17bef71adc7e2f13b63c51476';

test('accepts the Webex link and ordinary password supplied directly to the join tool', () => {
  const invitation = createInvitation(JOIN_LINK, 'tM9mpFci5C8');
  assert.equal(invitation.joinLink, JOIN_LINK);
  assert.equal(invitation.password, 'tM9mpFci5C8');
});

test('rejects a non-Webex link or an empty meeting password', () => {
  assert.equal(createInvitation('https://example.com/join', 'x'), null);
  assert.equal(createInvitation(JOIN_LINK, ''), null);
});

test('reports browser-control failures separately from Webex meeting failures', () => {
  assert.equal(safeErrorCode(Object.assign(new Error('fetch failed'), { code: 'browser_control_unavailable' })), 'browser_control_unavailable');
  assert.equal(safeErrorCode(Object.assign(new Error('forbidden'), { code: 'browser_control_unauthorized' })), 'browser_control_unauthorized');
});

test('session-scoped browser actions send exactly one internally resolved targetId', async () => {
  const originalFetch = global.fetch;
  const originalToken = process.env.OPENCLAW_GATEWAY_TOKEN;
  const calls = [];
  process.env.OPENCLAW_GATEWAY_TOKEN = 'gateway-token';
  global.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    return { ok: true, json: async () => ({ ok: true, targetId: 'RAW-TARGET', snapshot: 'button "Join Webex meeting" [ref=12]' }) };
  };
  try {
    const browser = new BrowserControl('meeting-join');
    await browser.snapshot('t2');
    await browser.click('t2', '12');

    assert.match(calls[0].url, /\/snapshot\?.*targetId=t2/);
    assert.match(calls[0].url, /profile=meeting-join/);
    assert.deepEqual(JSON.parse(calls[1].init.body), { kind: 'click', targetId: 't2', ref: '12' });
  } finally {
    global.fetch = originalFetch;
    if (originalToken === undefined) delete process.env.OPENCLAW_GATEWAY_TOKEN;
    else process.env.OPENCLAW_GATEWAY_TOKEN = originalToken;
  }
});

test('tab creation assigns the stable meeting label atomically', async () => {
  const originalFetch = global.fetch;
  const originalToken = process.env.OPENCLAW_GATEWAY_TOKEN;
  let call;
  process.env.OPENCLAW_GATEWAY_TOKEN = 'gateway-token';
  global.fetch = async (url, init = {}) => {
    call = { url: String(url), init };
    return { ok: true, json: async () => ({ targetId: 'RAW-1', tabId: 't1', suggestedTargetId: 'meeting:room' }) };
  };
  try {
    const browser = new BrowserControl('meeting-join');
    assert.equal(await browser.open('http://127.0.0.1/runner', 'meeting:room'), 'meeting:room');
    assert.match(call.url, /\/tabs\/open/);
    assert.deepEqual(JSON.parse(call.init.body), {
      url: 'http://127.0.0.1/runner',
      label: 'meeting:room',
    });
  } finally {
    global.fetch = originalFetch;
    if (originalToken === undefined) delete process.env.OPENCLAW_GATEWAY_TOKEN;
    else process.env.OPENCLAW_GATEWAY_TOKEN = originalToken;
  }
});

test('preserves structured OpenClaw action errors instead of hiding target mismatches', async () => {
  const originalFetch = global.fetch;
  const originalToken = process.env.OPENCLAW_GATEWAY_TOKEN;
  process.env.OPENCLAW_GATEWAY_TOKEN = 'gateway-token';
  global.fetch = async () => ({
    ok: false,
    status: 403,
    json: async () => ({ error: 'action targetId must match request targetId', code: 'ACT_TARGET_ID_MISMATCH' }),
  });
  try {
    const browser = new BrowserControl('meeting-join');
    await assert.rejects(
      browser.click('RAW-1', '12'),
      (error) => {
        assert.ok(error instanceof BrowserControlError);
        assert.equal(error.status, 403);
        assert.equal(error.controlCode, 'ACT_TARGET_ID_MISMATCH');
        assert.deepEqual(browserActionFailure(error), {
          error_code: 'browser_target_id_mismatch',
          retryable: false,
        });
        return true;
      }
    );
  } finally {
    global.fetch = originalFetch;
    if (originalToken === undefined) delete process.env.OPENCLAW_GATEWAY_TOKEN;
    else process.env.OPENCLAW_GATEWAY_TOKEN = originalToken;
  }
});

test('binds a runner ref to the exact raw targetId returned by its snapshot', async () => {
  const service = new MeetingJoinService({}, { requireBrowserReview: true }, { warn() {} });
  const clicks = [];
  service.startTask = Promise.resolve();
  service.enabled = true;
  service.state = {
    version: 1,
    sessions: {
      session: {
        id: 'session', roomId: 'room', state: 'ready_for_browser', tabId: 'meeting:room',
        invitation: { joinLink: JOIN_LINK, password: 'secret', discoveredAt: 'now' },
        recoveryAttempts: 0, createdAt: 'now', updatedAt: 'now',
      },
    },
  };
  service.browser = {
    start: async () => ({}),
    snapshot: async (tabId) => {
      assert.equal(tabId, 'meeting:room');
      return { targetId: 'RAW-FROM-SNAPSHOT', snapshot: 'button "Join Webex meeting" [ref=12]' };
    },
    click: async (targetId, ref) => clicks.push({ targetId, ref }),
  };

  assert.equal((await service.inspectRunner('session')).ok, true);
  assert.equal((await service.actOnRunner('session', '12')).ok, true);
  assert.deepEqual(clicks, [{ targetId: 'RAW-FROM-SNAPSHOT', ref: '12' }]);

  const replay = await service.actOnRunner('session', '12');
  assert.equal(replay.error_code, 'meeting_runner_snapshot_required');
});

test('rejects refs that were not present in the latest runner snapshot', async () => {
  const service = new MeetingJoinService({}, { requireBrowserReview: true }, { warn() {} });
  service.startTask = Promise.resolve();
  service.enabled = true;
  service.state = {
    version: 1,
    sessions: {
      session: {
        id: 'session', roomId: 'room', state: 'ready_for_browser', tabId: 'meeting:room',
        invitation: { joinLink: JOIN_LINK, password: 'secret', discoveredAt: 'now' },
        recoveryAttempts: 0, createdAt: 'now', updatedAt: 'now',
      },
    },
  };
  service.browser = {
    start: async () => ({}),
    snapshot: async () => ({ targetId: 'RAW-1', snapshot: 'button "Join Webex meeting" [ref=e7]' }),
    click: async () => assert.fail('uninspected ref was clicked'),
  };

  await service.inspectRunner('session');
  const result = await service.actOnRunner('session', 'e8');
  assert.equal(result.error_code, 'meeting_runner_snapshot_required');
});

test('surfaces an internal target mismatch as a non-retryable compatibility failure', async () => {
  const service = new MeetingJoinService({}, { requireBrowserReview: true }, { warn() {} });
  service.startTask = Promise.resolve();
  service.enabled = true;
  service.state = {
    version: 1,
    sessions: {
      session: {
        id: 'session', roomId: 'room', state: 'ready_for_browser', tabId: 'meeting:room',
        inspectedTargetId: 'RAW-1', inspectedRefs: ['12'],
        invitation: { joinLink: JOIN_LINK, password: 'secret', discoveredAt: 'now' },
        recoveryAttempts: 0, createdAt: 'now', updatedAt: 'now',
      },
    },
  };
  service.browser = {
    start: async () => ({}),
    click: async () => {
      throw new BrowserControlError('mismatch', 'browser_control_unauthorized', {
        status: 403,
        controlCode: 'ACT_TARGET_ID_MISMATCH',
        controlError: 'action targetId must match request targetId',
      });
    },
  };

  const result = await service.actOnRunner('session', '12');
  assert.equal(result.error_code, 'browser_target_id_mismatch');
  assert.equal(result.retryable, false);
});

test('extracts all supported actionable ref formats from snapshots', () => {
  assert.deepEqual(
    snapshotRefs({
      snapshot: 'button [ref=12]\nlink [ref=e3]\nbutton aria-ref="44"',
      refs: { ax9: { role: 'button' } },
    }).sort(),
    ['12', '44', 'ax9', 'e3'].sort()
  );
});

test('encrypted state keeps active-session and OAuth credentials out of plaintext storage', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'meeting-join-test-'));
  try {
    const statePath = path.join(dir, 'state.enc');
    const key = Buffer.alloc(32, 7).toString('base64');
    const store = new EncryptedState(key, statePath);
    const state = {
      version: 1,
      sessions: {
        active: {
          id: 'active', roomId: 'room', invitation: { joinLink: JOIN_LINK, password: 'secret-pass', discoveredAt: 'now' },
          state: 'joined', recoveryAttempts: 0, createdAt: 'now', updatedAt: 'now',
        },
      },
      token: { accessToken: 'access-secret', refreshToken: 'refresh-secret', expiresAt: 1 },
    };
    await store.save(state);
    const raw = await readFile(statePath, 'utf8');
    assert.doesNotMatch(raw, /secret-pass|access-secret|refresh-secret/);
    assert.deepEqual(await store.load(), state);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
