'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { createOrchestrator } = require('./orchestrator');

function response(data) {
  return { ok: true, json: async () => data, text: async () => '' };
}

// Fakes out the meeting account's REST calls directly (bypassing global
// fetch entirely, since tokenStore.meetingFetch is injected) and returns
// canned data keyed by path substring.
function fakeMeetingFetch(routes) {
  return async (path) => {
    for (const [match, data] of routes) {
      if (path.includes(match)) return data;
    }
    throw new Error(`unexpected meetingFetch call: ${path}`);
  };
}

function fakeTokenStore(routes) {
  return {
    getToken: () => 'meeting-token',
    refresh: async () => 'meeting-token',
    meetingFetch: fakeMeetingFetch(routes),
  };
}

function fakeBrowserRuntime() {
  const calls = { init: [], join: [], leave: [] };
  return {
    calls,
    init: async (token) => { calls.init.push(token); },
    join: async (destination, type) => {
      calls.join.push({ destination, type });
      return 'sdk-meeting-1';
    },
    leave: async (reference) => { calls.leave.push(reference); },
    syncActive: async () => [],
    dispose: async () => {},
  };
}

function baseCfg(overrides = {}) {
  return { botToken: 'bot-token', pollIntervalMs: 999_999, joinTimeoutMs: 1000, ...overrides };
}

test('start() resolves both identities and initializes the browser runtime with the meeting token', async () => {
  const originalFetch = global.fetch;
  global.fetch = async (url) => {
    assert.match(String(url), /\/people\/me$/);
    return response({ id: 'bot-id' });
  };
  try {
    const browserRuntime = fakeBrowserRuntime();
    const orchestrator = createOrchestrator({
      cfg: baseCfg(),
      tokenStore: fakeTokenStore([['/people/me', { id: 'meeting-person-id' }]]),
      browserRuntime,
    });
    await orchestrator.start();
    assert.deepEqual(browserRuntime.calls.init, ['meeting-token']);
  } finally {
    global.fetch = originalFetch;
  }
});

test('handleMeetingStarted joins a member space meeting and announces success', async () => {
  const originalFetch = global.fetch;
  const posted = [];
  global.fetch = async (url, opts = {}) => {
    if (String(url).endsWith('/people/me')) return response({ id: 'bot-id' });
    if (String(url).endsWith('/messages')) {
      posted.push(JSON.parse(opts.body));
      return response({ id: 'msg-1' });
    }
    throw new Error(`unexpected bot-token fetch: ${url}`);
  };
  try {
    const browserRuntime = fakeBrowserRuntime();
    const orchestrator = createOrchestrator({
      cfg: baseCfg(),
      tokenStore: fakeTokenStore([
        ['/people/me', { id: 'meeting-person-id' }],
        ['/memberships?', { items: [{ id: 'membership-1' }] }],
        ['/meetings/meeting-1', { id: 'meeting-1', roomId: 'room-1', sipUrl: 'sip:x@webex.com', meetingType: 'meeting' }],
      ]),
      browserRuntime,
    });
    await orchestrator.start();
    await orchestrator.handleMeetingStarted({ data: { id: 'meeting-1' } });

    assert.equal(orchestrator.state.isJoined('meeting-1'), true);
    assert.equal(orchestrator.state.joined.get('meeting-1').sdkMeetingId, 'sdk-meeting-1');
    assert.deepEqual(browserRuntime.calls.join, [{ destination: 'sip:x@webex.com', type: 'SIP_URI' }]);
    assert.equal(posted.at(-1).roomId, 'room-1');
    assert.match(posted.at(-1).markdown, /Joined/);
  } finally {
    global.fetch = originalFetch;
  }
});

test('handleMeetingStarted is idempotent — a repeated webhook does not double-join', async () => {
  const originalFetch = global.fetch;
  global.fetch = async (url, opts = {}) => {
    if (String(url).endsWith('/people/me')) return response({ id: 'bot-id' });
    if (String(url).endsWith('/messages')) return response({ id: 'msg-1' });
    throw new Error(`unexpected fetch: ${url}`);
  };
  try {
    const browserRuntime = fakeBrowserRuntime();
    const orchestrator = createOrchestrator({
      cfg: baseCfg(),
      tokenStore: fakeTokenStore([
        ['/people/me', { id: 'meeting-person-id' }],
        ['/memberships?', { items: [{ id: 'membership-1' }] }],
        ['/meetings/meeting-1', { id: 'meeting-1', roomId: 'room-1', id: 'meeting-1' }],
      ]),
      browserRuntime,
    });
    await orchestrator.start();
    await orchestrator.handleMeetingStarted({ data: { id: 'meeting-1' } });
    await orchestrator.handleMeetingStarted({ data: { id: 'meeting-1' } });
    assert.equal(browserRuntime.calls.join.length, 1);
  } finally {
    global.fetch = originalFetch;
  }
});

test('handleMeetingStarted skips a meeting with no roomId (not a space meeting) without calling join', async () => {
  const originalFetch = global.fetch;
  global.fetch = async (url) => {
    if (String(url).endsWith('/people/me')) return response({ id: 'bot-id' });
    throw new Error(`unexpected fetch: ${url}`);
  };
  try {
    const browserRuntime = fakeBrowserRuntime();
    const orchestrator = createOrchestrator({
      cfg: baseCfg(),
      tokenStore: fakeTokenStore([
        ['/people/me', { id: 'meeting-person-id' }],
        ['/meetings/meeting-1', { id: 'meeting-1' }],
      ]),
      browserRuntime,
    });
    await orchestrator.start();
    await orchestrator.handleMeetingStarted({ data: { id: 'meeting-1' } });
    assert.equal(browserRuntime.calls.join.length, 0);
    assert.equal(orchestrator.state.isJoined('meeting-1'), false);
  } finally {
    global.fetch = originalFetch;
  }
});

test('a join failure announces a manual-fallback message and does not mark the meeting joined', async () => {
  const originalFetch = global.fetch;
  const posted = [];
  global.fetch = async (url, opts = {}) => {
    if (String(url).endsWith('/people/me')) return response({ id: 'bot-id' });
    if (String(url).endsWith('/messages')) {
      posted.push(JSON.parse(opts.body));
      return response({ id: 'msg-1' });
    }
    throw new Error(`unexpected fetch: ${url}`);
  };
  try {
    const browserRuntime = fakeBrowserRuntime();
    browserRuntime.join = async () => { throw new Error('SDK join rejected'); };
    const orchestrator = createOrchestrator({
      cfg: baseCfg(),
      tokenStore: fakeTokenStore([
        ['/people/me', { id: 'meeting-person-id' }],
        ['/memberships?', { items: [{ id: 'm1' }] }],
        ['/meetings/meeting-1', { id: 'meeting-1', roomId: 'room-1' }],
      ]),
      browserRuntime,
    });
    await orchestrator.start();
    await assert.rejects(orchestrator.handleMeetingStarted({ data: { id: 'meeting-1' } }), /SDK join rejected/);
    assert.equal(orchestrator.state.isJoined('meeting-1'), false);
    assert.match(posted.at(-1).markdown, /couldn't join/);
  } finally {
    global.fetch = originalFetch;
  }
});

test('handleMeetingEnded clears local state even if we never actually joined', async () => {
  const browserRuntime = fakeBrowserRuntime();
  const orchestrator = createOrchestrator({
    cfg: baseCfg(),
    tokenStore: fakeTokenStore([]),
    browserRuntime,
  });
  orchestrator.state.markJoined('meeting-1', { roomId: 'room-1' });
  await orchestrator.handleMeetingEnded({ data: { id: 'meeting-1' } });
  assert.equal(orchestrator.state.isJoined('meeting-1'), false);
});

test('handleMessageCreated leaves the meeting when addressed and asked to leave', async () => {
  const originalFetch = global.fetch;
  const posted = [];
  global.fetch = async (url, opts = {}) => {
    if (String(url).endsWith('/people/me')) return response({ id: 'bot-id' });
    if (String(url).endsWith('/messages/msg-1')) {
      return response({ id: 'msg-1', personId: 'human-1', roomId: 'room-1', roomType: 'group', mentionedPeople: ['bot-id'], text: '@Bot leave meeting' });
    }
    if (String(url).endsWith('/messages')) {
      posted.push(JSON.parse(opts.body));
      return response({ id: 'ack' });
    }
    throw new Error(`unexpected fetch: ${url}`);
  };
  try {
    const browserRuntime = fakeBrowserRuntime();
    const orchestrator = createOrchestrator({
      cfg: baseCfg(),
      tokenStore: fakeTokenStore([['/people/me', { id: 'meeting-person-id' }]]),
      browserRuntime,
    });
    await orchestrator.start();
    orchestrator.state.markJoined('meeting-1', { roomId: 'room-1' });

    await orchestrator.handleMessageCreated({ data: { id: 'msg-1' } });

    assert.deepEqual(browserRuntime.calls.leave, [{
      meetingId: 'meeting-1',
      sdkMeetingId: undefined,
      destination: undefined,
    }]);
    assert.equal(orchestrator.state.isJoined('meeting-1'), false);
    assert.equal(orchestrator.state.isSuppressed('meeting-1'), true);
    assert.match(posted.at(-1).markdown, /Left the meeting/);
  } finally {
    global.fetch = originalFetch;
  }
});

test('handleMessageCreated ignores messages not addressed to the bot', async () => {
  const originalFetch = global.fetch;
  global.fetch = async (url) => {
    if (String(url).endsWith('/people/me')) return response({ id: 'bot-id' });
    if (String(url).endsWith('/messages/msg-1')) {
      return response({ id: 'msg-1', personId: 'human-1', roomId: 'room-1', roomType: 'group', mentionedPeople: [], text: 'leave meeting' });
    }
    throw new Error(`unexpected fetch: ${url}`);
  };
  try {
    const browserRuntime = fakeBrowserRuntime();
    const orchestrator = createOrchestrator({
      cfg: baseCfg(),
      tokenStore: fakeTokenStore([['/people/me', { id: 'meeting-person-id' }]]),
      browserRuntime,
    });
    await orchestrator.start();
    orchestrator.state.markJoined('meeting-1', { roomId: 'room-1' });
    await orchestrator.handleMessageCreated({ data: { id: 'msg-1' } });
    assert.equal(browserRuntime.calls.leave.length, 0);
    assert.equal(orchestrator.state.isJoined('meeting-1'), true);
  } finally {
    global.fetch = originalFetch;
  }
});

test('reconcile() joins active meetings missed by the started webhook', async () => {
  const originalFetch = global.fetch;
  const posted = [];
  global.fetch = async (url, opts = {}) => {
    if (String(url).endsWith('/people/me')) return response({ id: 'bot-id' });
    if (String(url).endsWith('/messages')) {
      posted.push(JSON.parse(opts.body));
      return response({ id: 'ack' });
    }
    throw new Error(`unexpected fetch: ${url}`);
  };
  try {
    const browserRuntime = fakeBrowserRuntime();
    const orchestrator = createOrchestrator({
      cfg: baseCfg(),
      tokenStore: fakeTokenStore([
        ['/people/me', { id: 'meeting-person-id' }],
        ['/memberships?', { items: [{ id: 'm1' }] }],
        ['/meetings?', { items: [{ id: 'meeting-1', roomId: 'room-1', state: 'inprogress', sipUrl: 'sip:x@webex.com' }] }],
      ]),
      browserRuntime,
    });
    await orchestrator.start();
    await orchestrator.reconcile();
    assert.equal(orchestrator.state.isJoined('meeting-1'), true);
    assert.deepEqual(browserRuntime.calls.join, [{ destination: 'sip:x@webex.com', type: 'SIP_URI' }]);
  } finally {
    global.fetch = originalFetch;
  }
});

test('reconcile() does not rejoin a meeting the user explicitly asked us to leave', async () => {
  const originalFetch = global.fetch;
  global.fetch = async (url) => {
    if (String(url).endsWith('/people/me')) return response({ id: 'bot-id' });
    throw new Error(`unexpected fetch: ${url}`);
  };
  try {
    const browserRuntime = fakeBrowserRuntime();
    const orchestrator = createOrchestrator({
      cfg: baseCfg(),
      tokenStore: fakeTokenStore([
        ['/people/me', { id: 'meeting-person-id' }],
        ['/meetings?', { items: [{ id: 'meeting-1', roomId: 'room-1', state: 'inprogress' }] }],
      ]),
      browserRuntime,
    });
    await orchestrator.start();
    orchestrator.state.suppressed.add('meeting-1');
    await orchestrator.reconcile();
    assert.equal(browserRuntime.calls.join.length, 0);
  } finally {
    global.fetch = originalFetch;
  }
});
