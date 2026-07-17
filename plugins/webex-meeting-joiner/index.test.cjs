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
    WEBEX_MEETING_WEBHOOK_URL: 'https://example.test/webhooks/webex-meetings/default',
    WEBEX_MEETING_WEBHOOK_SECRET: 'secret',
  });
  assert.equal(config.accessToken, 'meeting-oauth');
  assert.equal(config.botToken, 'bot-token');
  assert.throws(() => getConfig({ WEBEX_BOT_TOKEN: 'bot-token' }), /WEBEX_MEETING_ACCESS_TOKEN/);
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
});
