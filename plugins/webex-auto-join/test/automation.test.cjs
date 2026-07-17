'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { MeetingJoinService } = require('../dist/service.cjs');

function state(overrides = {}) {
  return {
    version: 2,
    sessions: {},
    rooms: {},
    schedules: {},
    pending: {},
    notifications: {},
    ...overrides,
  };
}

function response(data = {}, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get() { return ''; } },
    text: async () => status === 204 ? '' : JSON.stringify(data),
    json: async () => data,
  };
}

function membershipService() {
  const service = new MeetingJoinService({}, {
    botToken: 'bot-token',
    expectedAttendeeEmail: 'attendee@example.com',
  }, { warn() {} });
  service.enabled = true;
  service.startTask = Promise.resolve();
  service.store = { save: async () => {} };
  service.state = state();
  return service;
}

test('startup membership reconciliation adds a missing attendee and records provenance', async () => {
  const originalFetch = global.fetch;
  const calls = [];
  global.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), method: init.method ?? 'GET', body: init.body && JSON.parse(init.body) });
    if (String(url).includes('/rooms?')) return response({ items: [{ id: 'room-1', type: 'group', title: 'Project' }] });
    if (String(url).includes('/memberships?')) return response({ items: [] });
    if (String(url).endsWith('/memberships') && init.method === 'POST') return response({ id: 'membership-1' }, 201);
    return response();
  };
  try {
    const service = membershipService();
    await service.reconcileMemberships();
    assert.equal(service.state.rooms['room-1'].covered, true);
    assert.equal(service.state.rooms['room-1'].membershipProvenance, 'created');
    assert.deepEqual(calls.find((call) => call.method === 'POST').body, {
      roomId: 'room-1', personEmail: 'attendee@example.com', isModerator: false,
    });
  } finally {
    global.fetch = originalFetch;
  }
});

test('an already-present attendee is covered without creating another membership', async () => {
  const originalFetch = global.fetch;
  const calls = [];
  global.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), method: init.method ?? 'GET' });
    if (String(url).includes('/rooms?')) return response({ items: [{ id: 'room-1', type: 'group' }] });
    if (String(url).includes('/memberships?')) return response({ items: [{ id: 'existing-membership' }] });
    return response();
  };
  try {
    const service = membershipService();
    await service.reconcileMemberships();
    assert.equal(service.state.rooms['room-1'].membershipProvenance, 'existing');
    assert.equal(calls.some((call) => call.method === 'POST'), false);
  } finally {
    global.fetch = originalFetch;
  }
});

test('moderated-space membership failures mark coverage and notify once', async () => {
  const originalFetch = global.fetch;
  const calls = [];
  global.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), method: init.method ?? 'GET' });
    if (String(url).includes('/rooms?')) return response({ items: [{ id: 'room-1', type: 'group' }] });
    if (String(url).includes('/memberships?')) return response({ items: [] });
    if (String(url).endsWith('/memberships')) return response({ message: 'moderated' }, 403);
    if (String(url).endsWith('/messages')) return response({ id: 'message-1' }, 201);
    return response();
  };
  try {
    const service = membershipService();
    await service.reconcileMemberships();
    await service.reconcileMemberships();
    assert.equal(service.state.rooms['room-1'].covered, false);
    assert.equal(service.state.rooms['room-1'].lastError, 'membership_mirror_failed');
    assert.equal(calls.filter((call) => call.url.endsWith('/messages')).length, 1);
  } finally {
    global.fetch = originalFetch;
  }
});

test('bot removal only deletes attendee memberships created by this plugin', async () => {
  const originalFetch = global.fetch;
  const calls = [];
  global.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), method: init.method ?? 'GET' });
    return response({}, init.method === 'DELETE' ? 204 : 200);
  };
  try {
    const service = membershipService();
    service.state = state({
      rooms: {
        created: { roomId: 'created', covered: true, membershipId: 'created-membership', membershipProvenance: 'created', updatedAt: 'now' },
        existing: { roomId: 'existing', covered: true, membershipId: 'existing-membership', membershipProvenance: 'existing', updatedAt: 'now' },
      },
      token: { accessToken: 'attendee-token', refreshToken: 'refresh', expiresAt: Date.now() + 600_000 },
    });
    await service.removeManagedRoom('created');
    await service.removeManagedRoom('existing');
    assert.equal(calls.some((call) => call.method === 'DELETE' && call.url.endsWith('/memberships/created-membership')), true);
    assert.equal(calls.some((call) => call.url.endsWith('/memberships/existing-membership')), false);
  } finally {
    global.fetch = originalFetch;
  }
});

test('scheduled meeting updates replace persisted timing and rebuild their timer', async () => {
  const service = membershipService();
  service.state.rooms.room = { roomId: 'room', covered: true, updatedAt: 'now' };
  const firstStart = new Date(Date.now() + 3_600_000).toISOString();
  const secondStart = new Date(Date.now() + 7_200_000).toISOString();
  await service.processMeeting({
    id: 'scheduled-1', meetingType: 'scheduledMeeting', state: 'scheduled', roomId: 'room',
    title: 'Planning', start: firstStart, end: new Date(Date.now() + 10_800_000).toISOString(),
    webLink: 'https://example.webex.com/meet/planning',
  });
  const firstTimer = service.scheduleTimers.get('scheduled-1');
  await service.processMeeting({
    id: 'scheduled-1', meetingType: 'scheduledMeeting', state: 'scheduled', roomId: 'room',
    title: 'Planning moved', start: secondStart, end: new Date(Date.now() + 14_400_000).toISOString(),
    webLink: 'https://example.webex.com/meet/planning',
  });
  assert.equal(service.state.schedules['scheduled-1'].start, secondStart);
  assert.equal(service.state.schedules['scheduled-1'].title, 'Planning moved');
  assert.notEqual(service.scheduleTimers.get('scheduled-1'), firstTimer);
  service.deleteSchedule('scheduled-1');
});

test('meeting series expand into upcoming scheduled occurrences', async () => {
  const originalFetch = global.fetch;
  const start = new Date(Date.now() + 3_600_000).toISOString();
  global.fetch = async (url) => {
    assert.ok(String(url).includes('meetingSeriesId=series-1'));
    return response({ items: [{
      id: 'occurrence-1', meetingSeriesId: 'series-1', meetingType: 'scheduledMeeting',
      state: 'scheduled', start,
      webLink: 'https://example.webex.com/meet/series',
    }] });
  };
  try {
    const service = membershipService();
    service.state.rooms.room = { roomId: 'room', covered: true, updatedAt: 'now' };
    service.state.token = { accessToken: 'attendee-token', refreshToken: 'refresh', expiresAt: Date.now() + 600_000 };
    await service.processMeeting({ id: 'series-1', meetingType: 'meetingSeries', state: 'active', roomId: 'room' });
    assert.equal(service.state.schedules['occurrence-1'].seriesId, 'series-1');
    service.deleteSchedule('occurrence-1');
  } finally {
    global.fetch = originalFetch;
  }
});

test('OAuth refresh-token rotation is persisted before the token is used', async () => {
  const originalFetch = global.fetch;
  global.fetch = async (url) => {
    assert.ok(String(url).endsWith('/access_token'));
    return response({ access_token: 'new-access', refresh_token: 'new-refresh', expires_in: 3600 });
  };
  try {
    let persisted = false;
    const service = new MeetingJoinService({}, {
      attendeeClientId: 'client', attendeeClientSecret: 'secret', attendeeRefreshToken: 'old-refresh',
    }, { warn() {} });
    service.store = { save: async () => { persisted = true; } };
    service.state = state();
    assert.equal(await service.getAccessToken(), 'new-access');
    assert.equal(service.state.token.refreshToken, 'new-refresh');
    assert.equal(persisted, true);
  } finally {
    global.fetch = originalFetch;
  }
});

test('meeting completion frees capacity and starts the oldest pending join', async () => {
  const service = membershipService();
  service.cfg.maxConcurrentMeetings = 1;
  service.browser = { close: async () => {} };
  service.state = state({
    rooms: {
      'room-1': { roomId: 'room-1', covered: true, updatedAt: 'now' },
      'room-2': { roomId: 'room-2', covered: true, updatedAt: 'now' },
    },
    sessions: {
      active: {
        id: 'active', roomId: 'room-1', source: 'automatic', state: 'joined',
        invitation: { destination: 'meeting-1', meetingId: 'meeting-1', discoveredAt: 'now' },
        recoveryAttempts: 0, createdAt: 'now', updatedAt: 'now',
      },
    },
    pending: {
      'meeting-2': {
        meetingId: 'meeting-2', roomId: 'room-2', destination: 'meeting-2',
        webLink: 'https://example.webex.com/meet/pending',
        expiresAt: new Date(Date.now() + 60_000).toISOString(), updatedAt: '2026-01-01T00:00:00.000Z',
      },
    },
  });
  service.launch = async (session) => { session.tabId = 'new-runner'; };
  await service.completeEnd(service.state.sessions.active);

  assert.equal(service.state.sessions.active.state, 'ended');
  assert.equal(service.state.pending['meeting-2'], undefined);
  assert.equal(Object.values(service.state.sessions).some((session) => session.invitation.meetingId === 'meeting-2' && session.state === 'joining'), true);
});

test('an ended webhook closes the matching instance without fetching an unlisted meeting', async () => {
  const service = membershipService();
  service.browser = { close: async () => {} };
  service.state = state({
    rooms: { room: { roomId: 'room', covered: true, updatedAt: 'now' } },
    sessions: {
      active: {
        id: 'active', roomId: 'room', source: 'automatic', state: 'joined',
        invitation: { destination: 'meeting', meetingId: 'meeting-42', discoveredAt: 'now' },
        recoveryAttempts: 0, createdAt: 'now', updatedAt: 'now',
      },
    },
  });
  let fetched = false;
  service.fetchMeetingWithRetry = async () => { fetched = true; throw new Error('must not fetch ended meeting'); };

  await service.dispatchWebhook({
    resource: 'meetings', event: 'ended', data: { id: 'meeting-42_I_7', roomId: 'room' },
  });

  assert.equal(fetched, false);
  assert.equal(service.state.sessions.active.state, 'ended');
});

test('joined notifications are deduplicated per meeting', async () => {
  const service = membershipService();
  let sends = 0;
  service.messages = { send: async () => { sends += 1; } };
  const session = {
    id: 'session', roomId: 'room', source: 'automatic', state: 'joining',
    invitation: { destination: 'meeting', meetingId: 'meeting', discoveredAt: 'now' },
    recoveryAttempts: 0, createdAt: 'now', updatedAt: 'now',
  };
  service.state.sessions.session = session;
  await service.transition(session, 'joined');
  await service.transition(session, 'joined');
  assert.equal(sends, 1);
});

test('failure notifications include sanitized diagnostics and a session correlation id', async () => {
  const service = membershipService();
  let markdown = '';
  service.browser = { close: async () => {} };
  service.messages = { send: async (_roomId, value) => { markdown = value; } };
  const session = {
    id: 'session-debug', roomId: 'room', source: 'automatic', state: 'joining',
    invitation: { destination: 'meeting', meetingId: 'meeting-debug', discoveredAt: 'now' },
    recoveryAttempts: 0, createdAt: 'now', updatedAt: 'now',
  };
  service.state.sessions[session.id] = session;

  await service.fail(session, 'meeting_join_failed', 'stage=meeting_join; sdk_code=30105; message=unsupported destination');

  assert.match(markdown, /Error code: meeting_join_failed/);
  assert.match(markdown, /stage=meeting_join; sdk_code=30105/);
  assert.match(markdown, /Session: session-debug/);
});
