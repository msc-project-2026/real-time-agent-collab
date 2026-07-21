'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { createTokenStore } = require('./token');

function response(status, data) {
  return { ok: status >= 200 && status < 300, status, json: async () => data, text: async () => '' };
}

test('meetingFetch reactively refreshes once on a 401 and retries the call', async () => {
  const originalFetch = global.fetch;
  let refreshCalls = 0;
  let dataCalls = 0;
  global.fetch = async (url) => {
    const u = String(url);
    if (u.endsWith('/access_token')) {
      refreshCalls += 1;
      return response(200, { access_token: 'fresh-token' });
    }
    if (u.endsWith('/meetings/m1')) {
      dataCalls += 1;
      // First call (stale token) 401s, second call (fresh token) succeeds.
      return dataCalls === 1 ? response(401, {}) : response(200, { id: 'm1' });
    }
    throw new Error(`unexpected fetch: ${u}`);
  };
  try {
    const store = createTokenStore({
      meetingAccessToken: 'stale-token',
      meetingRefreshToken: 'refresh-tok',
      meetingClientId: 'id',
      meetingClientSecret: 'secret',
      canRefreshMeetingToken: true,
    });
    const result = await store.meetingFetch('/meetings/m1');
    assert.deepEqual(result, { id: 'm1' });
    assert.equal(refreshCalls, 1);
    assert.equal(dataCalls, 2);
    assert.equal(store.getToken(), 'fresh-token');
  } finally {
    global.fetch = originalFetch;
  }
});

test('meetingFetch surfaces the original 401 unchanged when refresh is not configured', async () => {
  const originalFetch = global.fetch;
  global.fetch = async () => response(401, {});
  try {
    const store = createTokenStore({ meetingAccessToken: 'stale', canRefreshMeetingToken: false });
    await assert.rejects(store.meetingFetch('/meetings/m1'), /401/);
  } finally {
    global.fetch = originalFetch;
  }
});

test('concurrent refresh() calls are coalesced into a single token-refresh request', async () => {
  const originalFetch = global.fetch;
  let refreshCalls = 0;
  global.fetch = async (url) => {
    if (String(url).endsWith('/access_token')) {
      refreshCalls += 1;
      await new Promise((r) => setTimeout(r, 5));
      return response(200, { access_token: 'fresh-token' });
    }
    throw new Error('unexpected');
  };
  try {
    const store = createTokenStore({
      meetingRefreshToken: 'r', meetingClientId: 'i', meetingClientSecret: 's', canRefreshMeetingToken: true,
    });
    await Promise.all([store.refresh(), store.refresh(), store.refresh()]);
    assert.equal(refreshCalls, 1);
    assert.equal(store.getToken(), 'fresh-token');
  } finally {
    global.fetch = originalFetch;
  }
});
