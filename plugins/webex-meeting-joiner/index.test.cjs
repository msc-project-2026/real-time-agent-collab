'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  MeetingJoiner,
  buildJoinPrompt,
  buildLeavePrompt,
  commandAction,
  getConfig,
  isExactReply,
  isStartedMeeting,
  meetingLink,
} = require('./index');

function runtimeReply(text) {
  return {
    config: { current: () => ({ configured: true }) },
    channel: {
      reply: {
        dispatchReplyWithBufferedBlockDispatcher: async (request) => {
          await request.dispatcherOptions.deliver({ text });
        },
      },
    },
  };
}

function response(data) {
  return { ok: true, json: async () => data, text: async () => '' };
}

test('join prompt uses the signed-in browser and requires disabled media', () => {
  const prompt = buildJoinPrompt('https://example.webex.com/meet/123');
  assert.match(prompt, /target="host", profile="openclaw"/);
  assert.match(prompt, /microphone and camera are both off/);
  assert.match(prompt, /inspect the actual page/);
  assert.match(prompt, /WEBEX_MEETING_JOINED/);
  assert.match(buildLeavePrompt(), /WEBEX_MEETING_LEFT/);
});

test('getConfig keeps the meeting OAuth account distinct from the bot account', () => {
  const config = getConfig({
    WEBEX_MEETING_ACCESS_TOKEN: 'meeting-oauth',
    WEBEX_BOT_TOKEN: 'bot-token',
    WEBEX_MEETING_POLL_INTERVAL_MS: '6000',
  });
  assert.equal(config.accessToken, 'meeting-oauth');
  assert.equal(config.botToken, 'bot-token');
  assert.equal(config.pollIntervalMs, 6000);
  assert.throws(() => getConfig({ WEBEX_BOT_TOKEN: 'bot-token' }), /WEBEX_MEETING_ACCESS_TOKEN/);
  assert.equal(getConfig({
    WEBEX_ACCESS_TOKEN: 'existing-oauth', WEBEX_BOT_TOKEN: 'bot-token',
  }).accessToken, 'existing-oauth');
});

test('scan joins a started meeting visible to the meeting account', async () => {
  const originalFetch = global.fetch;
  const sent = [];
  global.fetch = async (url, options = {}) => {
    const path = String(url);
    if (path.includes('/meetings?')) return response({
      items: [{ id: 'meeting-1', roomId: 'room-1', meetingType: 'meeting' }],
    });
    if (path.includes('/memberships?')) return response({ items: [{ id: 'membership-1' }] });
    if (path.endsWith('/meetings/meeting-1')) return response({
      id: 'meeting-1', roomId: 'room-1', webLink: 'https://example.webex.com/meet/1',
    });
    if (path.endsWith('/messages')) {
      sent.push(JSON.parse(options.body));
      return response({ id: 'message-id' });
    }
    throw new Error(`unexpected request: ${path}`);
  };
  try {
    const joiner = new MeetingJoiner({
      runtime: runtimeReply('WEBEX_MEETING_JOINED'),
      config: { botToken: 'bot-token', accessToken: 'oauth-token', botId: 'bot-id' },
    });
    await joiner.scanActiveMeetings();
    assert.equal(joiner.joinedMeetingIds.has('meeting-1'), true);
    assert.equal(sent[0].markdown, 'joined the meeting');
  } finally {
    global.fetch = originalFetch;
  }
});

test('join announces success only after the browser agent confirms entry', async () => {
  const originalFetch = global.fetch;
  const sent = [];
  global.fetch = async (url, options) => {
    sent.push({ url, options });
    return response({ id: 'message-id' });
  };
  try {
    const joiner = new MeetingJoiner({
      runtime: runtimeReply('WEBEX_MEETING_JOINED'),
      config: { botToken: 'bot-token', accessToken: 'oauth-token', botId: 'bot-id' },
    });
    const result = await joiner.join({ id: 'meeting-1', roomId: 'room-1', link: 'https://example.webex.com/meet/1' });
    assert.deepEqual(result, { joined: true });
    assert.equal(joiner.activeByRoom.get('room-1').joined, true);
    assert.equal(JSON.parse(sent[0].options.body).markdown, 'joined the meeting');
  } finally {
    global.fetch = originalFetch;
  }
});

test('leave suppresses rejoining that meeting until /meeting join is requested', async () => {
  const originalFetch = global.fetch;
  const sent = [];
  global.fetch = async (url, options) => {
    sent.push({ url, options });
    return response({ id: 'message-id' });
  };
  try {
    const joiner = new MeetingJoiner({
      runtime: runtimeReply('WEBEX_MEETING_LEFT'),
      config: { botToken: 'bot-token', accessToken: 'oauth-token', botId: 'bot-id' },
    });
    joiner.activeByRoom.set('room-1', {
      id: 'meeting-1', roomId: 'room-1', link: 'https://example.webex.com/meet/1', joined: true,
    });
    assert.equal(await joiner.handleCommand({ text: '/meeting leave', roomId: 'room-1' }), true);
    assert.equal(joiner.suppressedMeetingIds.has('meeting-1'), true);
    assert.deepEqual(
      await joiner.join({ id: 'meeting-1', roomId: 'room-1', link: 'https://example.webex.com/meet/1' }),
      { skipped: 'left-by-user' },
    );
    assert.equal(JSON.parse(sent.at(-1).options.body).markdown, 'left the meeting');
  } finally {
    global.fetch = originalFetch;
  }
});

test('meeting link selection does not parse text or use URL regexes', () => {
  assert.equal(meetingLink({ webLink: 'https://example.webex.com/meet/1' }), 'https://example.webex.com/meet/1');
  assert.equal(meetingLink({ joinLink: 'https://example.webex.com/meet/2' }), 'https://example.webex.com/meet/2');
  assert.equal(meetingLink({ webLink: 'javascript:alert(1)' }), null);
  assert.equal(isExactReply('done\nWEBEX_MEETING_JOINED', 'WEBEX_MEETING_JOINED'), true);
  assert.equal(commandAction('leave the meeting'), 'leave');
  assert.equal(commandAction('/meeting join'), 'join');
  assert.equal(isStartedMeeting({ meetingType: 'scheduledMeeting' }), false);
  assert.equal(isStartedMeeting({ meetingType: 'meeting' }), true);
});
