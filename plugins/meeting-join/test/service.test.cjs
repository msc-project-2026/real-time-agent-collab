'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { mkdtemp, readFile, rm } = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { BrowserControl, createInvitation, EncryptedState, safeErrorCode } = require('../dist/service.cjs');

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
    return { ok: true, json: async () => ({ ok: true, snapshot: 'button "Join Webex meeting" [ref=12]' }) };
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
