'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { getConfig } = require('./config');

test('getConfig falls back to the shared WEBEX_ACCESS_TOKEN family when WEBEX_MEETING_* is unset', () => {
  const cfg = getConfig({
    WEBEX_BOT_TOKEN: 'bot-token',
    WEBEX_ACCESS_TOKEN: 'shared-access',
    WEBEX_REFRESH_TOKEN: 'shared-refresh',
    WEBEX_CLIENT_ID: 'shared-id',
    WEBEX_CLIENT_SECRET: 'shared-secret',
    WEBEX_MEETING_WEBHOOK_URL: 'https://example.com/webhooks/webex-meeting-join',
  });
  assert.equal(cfg.meetingAccessToken, 'shared-access');
  assert.equal(cfg.meetingRefreshToken, 'shared-refresh');
  assert.equal(cfg.canRefreshMeetingToken, true);
  assert.equal(cfg.webhookBaseUrl, 'https://example.com/webhooks/webex-meeting-join');
});

test('getConfig prefers dedicated WEBEX_MEETING_* vars over the shared fallback', () => {
  const cfg = getConfig({
    WEBEX_BOT_TOKEN: 'bot-token',
    WEBEX_MEETING_ACCESS_TOKEN: 'dedicated-access',
    WEBEX_ACCESS_TOKEN: 'shared-access',
    WEBEX_MEETING_WEBHOOK_URL: 'https://example.com/webhooks/webex-meeting-join/',
  });
  assert.equal(cfg.meetingAccessToken, 'dedicated-access');
  assert.equal(cfg.canRefreshMeetingToken, false); // no refresh triple provided
  // trailing slash stripped so `${webhookBaseUrl}${pathSuffix}` never double-slashes
  assert.equal(cfg.webhookBaseUrl, 'https://example.com/webhooks/webex-meeting-join');
});

test('getConfig throws listing every missing required var', () => {
  assert.throws(() => getConfig({}), (err) => {
    assert.match(err.message, /WEBEX_BOT_TOKEN/);
    assert.match(err.message, /WEBEX_MEETING_ACCESS_TOKEN/);
    assert.match(err.message, /WEBEX_MEETING_WEBHOOK_URL/);
    return true;
  });
});

test('getConfig ignores an out-of-range poll interval and falls back to the default', () => {
  const cfg = getConfig({
    WEBEX_BOT_TOKEN: 'bot-token',
    WEBEX_ACCESS_TOKEN: 'shared-access',
    WEBEX_MEETING_WEBHOOK_URL: 'https://example.com/hook',
    WEBEX_MEETING_POLL_INTERVAL_MS: '10', // below the 30s floor
  });
  assert.equal(cfg.pollIntervalMs, 5 * 60 * 1000);
});
