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
  createDiscoveredInvitation,
  createInvitation,
  EncryptedState,
  MeetingJoinService,
  safeErrorCode,
  safePublicFailureDetail,
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

test('accepts a discovered meeting ID without requiring a password', () => {
  const invitation = createDiscoveredInvitation({ id: 'meeting-1', webLink: JOIN_LINK }, 'room-1');
  // destination must be an SDK-resolvable target (web link/SIP), never the raw
  // REST id, which the SDK misreads as a phone number.
  assert.equal(invitation.destination, JOIN_LINK);
  assert.equal(invitation.destinationKind, 'web_link');
  assert.equal(invitation.joinLink, JOIN_LINK);
  assert.equal(invitation.meetingId, 'meeting-1');
  assert.equal(invitation.password, undefined);
  assert.ok(Number.isFinite(Date.parse(invitation.discoveredAt)));
});

test('discovered destination prefers the web link, then falls back by kind', () => {
  const full = createDiscoveredInvitation(
    { id: 'meeting-1', sipAddress: '25501234567@webex.com', webLink: JOIN_LINK, meetingNumber: '2550 123 4567' },
    'room-1',
  );
  assert.equal(full.destination, JOIN_LINK);
  assert.equal(full.destinationKind, 'web_link');

  const noLink = createDiscoveredInvitation(
    { id: 'meeting-1', sipAddress: '25501234567@webex.com', meetingNumber: '2550 123 4567' },
    'room-1',
  );
  assert.equal(noLink.destination, '25501234567@webex.com');
  assert.equal(noLink.destinationKind, 'sip_address');

  const numberOnly = createDiscoveredInvitation({ id: 'meeting-1', meetingNumber: '2550 123 4567' }, 'room-1');
  assert.equal(numberOnly.destination, '2550 123 4567');
  assert.equal(numberOnly.destinationKind, 'meeting_number');

  const idOnly = createDiscoveredInvitation({ id: 'meeting-1' }, 'room-1');
  assert.equal(idOnly.destination, 'meeting-1');
  assert.equal(idOnly.destinationKind, 'meeting_id');
});

test('automatic joins deduplicate by meeting ID and room without an agent turn', async () => {
  const service = new MeetingJoinService({}, { maxConcurrentMeetings: 4 }, { warn() {} });
  service.startTask = Promise.resolve();
  service.enabled = true;
  service.store = { save: async () => {} };
  service.state = {
    version: 2,
    sessions: {},
    rooms: { room: { roomId: 'room', covered: true, updatedAt: 'now' } },
    schedules: {}, pending: {}, notifications: {},
  };
  service.launch = async (session) => { session.tabId = 'runner-tab'; };

  const first = await service.joinDiscoveredMeeting({
    id: 'meeting-1', meetingType: 'meeting', state: 'inProgress', roomId: 'room', webLink: JOIN_LINK,
  });
  const second = await service.joinDiscoveredMeeting({
    id: 'meeting-1', meetingType: 'meeting', state: 'inProgress', roomId: 'room', webLink: JOIN_LINK,
  });

  assert.equal(first.accepted, true);
  assert.equal(second.session_id, first.session_id);
  assert.equal(Object.keys(service.state.sessions).length, 1);
  assert.equal(service.state.sessions[first.session_id].source, 'automatic');
  assert.equal(service.state.sessions[first.session_id].invitation.password, undefined);
});

test('a user-left meeting is not auto-rejoined, but a new meeting still joins', async () => {
  const service = new MeetingJoinService({}, { maxConcurrentMeetings: 4 }, { warn() {} });
  service.startTask = Promise.resolve();
  service.enabled = true;
  service.store = { save: async () => {} };
  service.browser = { close: async () => {} };
  service.state = {
    version: 2,
    sessions: {},
    rooms: { room: { roomId: 'room', covered: true, updatedAt: 'now' } },
    schedules: {}, pending: {}, dismissed: {}, notifications: {},
  };
  service.launch = async (session) => { session.tabId = 'runner-tab'; };

  const discovered = { id: 'meeting-1', meetingType: 'meeting', state: 'inProgress', roomId: 'room', webLink: JOIN_LINK };

  const joined = await service.joinDiscoveredMeeting(discovered);
  assert.equal(joined.accepted, true);

  // User asks to leave; leaving completes to the terminal 'left' state.
  await service.leave('room');
  await service.completeLeave(service.state.sessions[joined.session_id]);
  assert.equal(service.state.sessions[joined.session_id].state, 'left');

  // Reconciliation re-discovers the same still-in-progress meeting: must NOT rejoin.
  const rejoin = await service.joinDiscoveredMeeting(discovered);
  assert.equal(rejoin.accepted, false);
  assert.equal(rejoin.error_code, 'meeting_left_by_user');
  assert.equal(Object.values(service.state.sessions).filter((s) => s.state === 'joined').length, 0);

  // A different meeting in the same space is unaffected and still auto-joins.
  const other = await service.joinDiscoveredMeeting({
    id: 'meeting-2', meetingType: 'meeting', state: 'inProgress', roomId: 'room', webLink: JOIN_LINK,
  });
  assert.equal(other.accepted, true);
});

test('a manually joined meeting is deduplicated by link, leavable from another space, and not rejoined', async () => {
  const service = new MeetingJoinService({}, { maxConcurrentMeetings: 4 }, { warn() {} });
  service.enabled = true;
  service.store = { save: async () => {} };
  service.browser = { close: async () => {} };
  service.state = {
    version: 2,
    sessions: {},
    rooms: { room: { roomId: 'room', covered: true, updatedAt: 'now' } },
    schedules: {}, pending: {}, dismissed: {}, notifications: {},
  };
  service.launch = async (session) => { session.tabId = 'runner-tab'; };

  const joined = await service.join({ room_id: 'room', meeting_link: JOIN_LINK, meeting_password: 'pw' });
  assert.equal(joined.accepted, true);

  // Discovery sees the same in-progress meeting under its REST id: it must
  // recognize the manual session by link — not queue the meeting as pending —
  // and backfill the id so a later leave dismisses the right instance.
  const discovered = { id: 'meeting-1', meetingType: 'meeting', state: 'inProgress', roomId: 'room', webLink: JOIN_LINK };
  const dedup = await service.joinDiscoveredMeeting(discovered);
  assert.equal(dedup.accepted, true);
  assert.equal(dedup.session_id, joined.session_id);
  assert.deepEqual(service.state.pending, {});
  assert.equal(service.state.sessions[joined.session_id].invitation.meetingId, 'meeting-1');

  // "Leave the meeting" arrives from a different space (e.g. a 1:1 with the
  // bot): the sole active meeting is still left.
  const left = await service.leave('direct-room');
  assert.equal(left.accepted, true);
  await service.completeLeave(service.state.sessions[joined.session_id]);
  assert.equal(service.state.sessions[joined.session_id].state, 'left');

  // Reconciliation re-discovers the still-in-progress meeting: must NOT rejoin.
  const rejoin = await service.joinDiscoveredMeeting(discovered);
  assert.equal(rejoin.accepted, false);
  assert.equal(rejoin.error_code, 'meeting_left_by_user');
});

test('leaving purges a pending duplicate of the same meeting so it cannot rejoin', async () => {
  const service = new MeetingJoinService({}, { maxConcurrentMeetings: 4 }, { warn() {} });
  service.enabled = true;
  service.store = { save: async () => {} };
  service.browser = { close: async () => {} };
  service.launch = async (session) => { session.tabId = 'runner-tab'; };
  // Pre-fix persisted state: the meeting the bot manually joined was also
  // queued as pending under its discovered id.
  service.state = {
    version: 2,
    sessions: {
      manual: {
        id: 'manual', roomId: 'room', source: 'manual', state: 'joined',
        invitation: { destination: JOIN_LINK, destinationKind: 'web_link', joinLink: JOIN_LINK, password: 'pw', discoveredAt: 'now' },
        recoveryAttempts: 0, createdAt: 'now', updatedAt: 'now',
      },
    },
    rooms: { room: { roomId: 'room', covered: true, updatedAt: 'now' } },
    schedules: {},
    pending: {
      'meeting-1': {
        meetingId: 'meeting-1', roomId: 'room', destination: JOIN_LINK, webLink: JOIN_LINK,
        expiresAt: new Date(Date.now() + 60 * 60_000).toISOString(), updatedAt: 'now',
      },
    },
    dismissed: {}, notifications: {},
  };

  const left = await service.leave('room');
  assert.equal(left.accepted, true);
  assert.equal(service.state.pending['meeting-1'], undefined);
  assert.ok(service.state.dismissed['meeting-1']);

  // completeLeave drains pending; nothing may rejoin.
  await service.completeLeave(service.state.sessions.manual);
  assert.equal(service.state.sessions.manual.state, 'left');
  assert.equal(Object.keys(service.state.sessions).length, 1);
});

test('a runner error during a requested leave settles as left instead of recovering', async () => {
  const service = new MeetingJoinService({}, { maxConcurrentMeetings: 4 }, { warn() {} });
  service.enabled = true;
  service.store = { save: async () => {} };
  service.browser = { close: async () => {} };
  service.state = {
    version: 2,
    sessions: {},
    rooms: { room: { roomId: 'room', covered: true, updatedAt: 'now' } },
    schedules: {}, pending: {}, dismissed: {}, notifications: {},
  };
  service.launch = async (session) => { session.tabId = 'runner-tab'; };

  const joined = await service.join({ room_id: 'room', meeting_link: JOIN_LINK, meeting_password: 'pw' });
  const session = service.state.sessions[joined.session_id];
  session.recoveryAttempts = 1; // an error would otherwise trigger a recovery relaunch
  await service.leave('room');
  await service.handleRunnerEvent(session, { type: 'error', code: 'meeting_join_failed' });
  assert.equal(session.state, 'left');
});

test('leave with several active meetings and no room match reports the candidates', async () => {
  const service = new MeetingJoinService({}, { maxConcurrentMeetings: 4 }, { warn() {} });
  service.enabled = true;
  service.store = { save: async () => {} };
  const activeSession = (id, roomId) => ({
    id, roomId, source: 'automatic', state: 'joined',
    invitation: { destination: JOIN_LINK, joinLink: JOIN_LINK, meetingId: `${id}-meeting`, discoveredAt: 'now' },
    recoveryAttempts: 0, createdAt: 'now', updatedAt: 'now',
  });
  service.state = {
    version: 2,
    sessions: { one: activeSession('one', 'room-1'), two: activeSession('two', 'room-2') },
    rooms: { 'room-1': { roomId: 'room-1', title: 'Design', covered: true, updatedAt: 'now' } },
    schedules: {}, pending: {}, dismissed: {}, notifications: {},
  };

  const result = await service.leave('room-3');
  assert.equal(result.accepted, false);
  assert.equal(result.error_code, 'ambiguous_active_meeting');
  assert.equal(result.active_meetings.length, 2);
  assert.equal(result.active_meetings[0].room_title, 'Design');
});

test('capacity-blocked automatic meetings remain pending', async () => {
  const service = new MeetingJoinService({}, { maxConcurrentMeetings: 1 }, { warn() {} });
  service.startTask = Promise.resolve();
  service.enabled = true;
  service.store = { save: async () => {} };
  service.state = {
    version: 2,
    sessions: {
      active: {
        id: 'active', roomId: 'room-1', source: 'automatic', state: 'joined',
        invitation: { destination: 'meeting-1', meetingId: 'meeting-1', discoveredAt: 'now' },
        recoveryAttempts: 0, createdAt: 'now', updatedAt: 'now',
      },
    },
    rooms: {
      'room-1': { roomId: 'room-1', covered: true, updatedAt: 'now' },
      'room-2': { roomId: 'room-2', covered: true, updatedAt: 'now' },
    },
    schedules: {}, pending: {}, notifications: {},
  };

  const result = await service.joinDiscoveredMeeting({
    id: 'meeting-2', roomId: 'room-2', webLink: JOIN_LINK, end: new Date(Date.now() + 60_000).toISOString(),
  });
  assert.deepEqual({ accepted: result.accepted, state: result.state, error_code: result.error_code }, {
    accepted: false, state: 'pending', error_code: 'capacity_reached',
  });
  assert.equal(service.state.pending['meeting-2'].roomId, 'room-2');
});

test('status exposes only sanitized failure codes', () => {
  const service = new MeetingJoinService({}, {}, { warn() {} });
  service.state = {
    version: 2,
    sessions: {
      failed: {
        id: 'failed', roomId: 'room', source: 'automatic', state: 'failed',
        invitation: { destination: 'meeting-1', meetingId: 'meeting-1', discoveredAt: 'now' },
        errorCode: 'secret=do-not-return', recoveryAttempts: 0, createdAt: 'now', updatedAt: '2026-01-01T00:00:00.000Z',
        errorDetail: 'stage=meeting_join; access_token=top-secret; url=https://example.webex.com/private',
      },
    },
    rooms: {}, schedules: {}, pending: {}, notifications: {},
  };
  assert.equal(service.status().failures[0].error_code, 'meeting_join_failed');
  assert.match(service.status().failures[0].error_detail, /stage=meeting_join/);
  assert.doesNotMatch(service.status().failures[0].error_detail, /top-secret|example\.webex\.com/);
});

test('sanitizes verbose diagnostics before they reach status or notifications', () => {
  const opaque = 'a'.repeat(40) + '==';
  const detail = safePublicFailureDetail(`stage=meeting_join; password=hunter2; https://example.webex.com/private; opaque=${opaque}`);
  assert.equal(detail.includes('stage=meeting_join'), true);
  assert.equal(detail.includes('password=[redacted]'), true);
  assert.equal(detail.includes('[redacted-url]'), true);
  assert.doesNotMatch(detail, /hunter2|example\.webex\.com|aaaaaaaaaa/);
});

test('reports browser-control failures separately from Webex meeting failures', () => {
  assert.equal(safeErrorCode(Object.assign(new Error('fetch failed'), { code: 'browser_control_unavailable' })), 'browser_control_unavailable');
  assert.equal(safeErrorCode(Object.assign(new Error('forbidden'), { code: 'browser_control_unauthorized' })), 'browser_control_unauthorized');
  assert.equal(safeErrorCode(Object.assign(new Error('bad request'), { status: 400 })), 'webex_request_invalid');
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
      version: 2,
      sessions: {
        active: {
          id: 'active', roomId: 'room', invitation: { joinLink: JOIN_LINK, password: 'secret-pass', discoveredAt: 'now' },
          state: 'joined', recoveryAttempts: 0, createdAt: 'now', updatedAt: 'now',
        },
      },
      rooms: {},
      schedules: {},
      pending: {},
      dismissed: {},
      notifications: {},
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

test('legacy migration imports only rotating OAuth token state', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'webex-auto-join-migration-'));
  try {
    const key = Buffer.alloc(32, 9).toString('base64');
    const legacyPath = path.join(dir, 'meeting-join-state.enc');
    const newPath = path.join(dir, 'webex-auto-join-state.enc');
    const legacy = new EncryptedState(key, legacyPath);
    await legacy.save({
      version: 1,
      sessions: {
        old: {
          id: 'old', roomId: 'room', state: 'joined',
          invitation: { joinLink: JOIN_LINK, password: 'legacy-password', discoveredAt: 'now' },
          recoveryAttempts: 0, createdAt: 'now', updatedAt: 'now',
        },
      },
      token: { accessToken: 'old-access', refreshToken: 'rotated-refresh', expiresAt: 123 },
    });
    const service = new MeetingJoinService({}, { encryptionKey: key }, { info() {} });
    service.store = new EncryptedState(key, newPath);
    service.state = { version: 2, sessions: {}, rooms: {}, schedules: {}, pending: {}, notifications: {} };
    await service.importLegacyToken(legacyPath);

    const migrated = await service.store.load();
    assert.deepEqual(migrated.sessions, {});
    assert.equal(migrated.token.refreshToken, 'rotated-refresh');
    assert.equal((await readFile(legacyPath, 'utf8')).includes('legacy-password'), false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
