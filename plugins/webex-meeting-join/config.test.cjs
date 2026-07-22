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

const baseEnv = {
  WEBEX_BOT_TOKEN: 'bot-token',
  WEBEX_ACCESS_TOKEN: 'shared-access',
  WEBEX_MEETING_WEBHOOK_URL: 'https://example.com/hook',
};

test('transcription is disabled with no DEEPGRAM_API_KEY and enabled with one', () => {
  const off = getConfig({ ...baseEnv });
  assert.equal(off.transcription.enabled, false);
  assert.equal(off.transcription.apiKey, undefined);

  const on = getConfig({ ...baseEnv, DEEPGRAM_API_KEY: 'dg-key' });
  assert.equal(on.transcription.enabled, true);
  assert.equal(on.transcription.apiKey, 'dg-key');
  // Sensible Flux defaults.
  assert.equal(on.transcription.model, 'flux-general-en');
  assert.equal(on.transcription.sampleRate, 16000);
  assert.equal(on.transcription.eotThreshold, 0.7);
  assert.equal(on.transcription.minTurnWords, 5);
});

test('transcription tunables come from env and out-of-range values fall back', () => {
  const cfg = getConfig({
    ...baseEnv,
    DEEPGRAM_API_KEY: 'dg-key',
    WEBEX_MEETING_DEEPGRAM_MODEL: 'flux-general-multi',
    WEBEX_MEETING_EOT_THRESHOLD: '0.9',
    WEBEX_MEETING_MIN_TURN_WORDS: '3',
    WEBEX_MEETING_GATE_THRESHOLD: '5', // out of (0,1] → default
  });
  assert.equal(cfg.transcription.model, 'flux-general-multi');
  assert.equal(cfg.transcription.eotThreshold, 0.9);
  assert.equal(cfg.transcription.minTurnWords, 3);
  assert.equal(cfg.transcription.gateThreshold, 0.7); // default kept
});
