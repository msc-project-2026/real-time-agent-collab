// Reads this plugin's own configuration directly from process.env — no
// config/openclaw.json schema wiring, so the plugin ports to another
// OpenClaw instance by copying the folder and setting these env vars.
'use strict';

const DEFAULT_POLL_INTERVAL_MS = 5 * 60 * 1000; // fallback reconciliation sweep
const DEFAULT_JOIN_TIMEOUT_MS = 20_000;
const MIN_POLL_INTERVAL_MS = 30_000;

function trimmed(v) {
  const s = v == null ? '' : String(v).trim();
  return s || undefined;
}

// The dedicated human "meeting" account's credentials fall back to the same
// vars the existing webex plugin already uses (WEBEX_ACCESS_TOKEN etc.) since
// the user confirmed those are already populated for that account. Dedicated
// WEBEX_MEETING_* vars let this plugin use a *different* account than the
// primary webex plugin if a deployment ever wants that split.
function getConfig(env = process.env) {
  const botToken = trimmed(env.WEBEX_BOT_TOKEN);
  const meetingAccessToken = trimmed(env.WEBEX_MEETING_ACCESS_TOKEN) ?? trimmed(env.WEBEX_ACCESS_TOKEN);
  const meetingRefreshToken = trimmed(env.WEBEX_MEETING_REFRESH_TOKEN) ?? trimmed(env.WEBEX_REFRESH_TOKEN);
  const meetingClientId = trimmed(env.WEBEX_MEETING_CLIENT_ID) ?? trimmed(env.WEBEX_CLIENT_ID);
  const meetingClientSecret = trimmed(env.WEBEX_MEETING_CLIENT_SECRET) ?? trimmed(env.WEBEX_CLIENT_SECRET);
  const webhookBaseUrl = trimmed(env.WEBEX_MEETING_WEBHOOK_URL);
  const webhookSecret = trimmed(env.WEBEX_WEBHOOK_SECRET);

  const missing = [
    !botToken && 'WEBEX_BOT_TOKEN',
    !meetingAccessToken && 'WEBEX_MEETING_ACCESS_TOKEN (or WEBEX_ACCESS_TOKEN)',
    !webhookBaseUrl && 'WEBEX_MEETING_WEBHOOK_URL',
  ].filter(Boolean);
  if (missing.length) throw new Error(`webex-meeting-join: missing ${missing.join(', ')}`);

  const pollIntervalMsRaw = Number(env.WEBEX_MEETING_POLL_INTERVAL_MS);
  const pollIntervalMs = Number.isFinite(pollIntervalMsRaw) && pollIntervalMsRaw >= MIN_POLL_INTERVAL_MS
    ? pollIntervalMsRaw
    : DEFAULT_POLL_INTERVAL_MS;

  const joinTimeoutMsRaw = Number(env.WEBEX_MEETING_JOIN_TIMEOUT_MS);
  const joinTimeoutMs = Number.isFinite(joinTimeoutMsRaw) && joinTimeoutMsRaw > 0
    ? joinTimeoutMsRaw
    : DEFAULT_JOIN_TIMEOUT_MS;

  // Optional path to the Chromium-based browser binary Playwright should
  // launch. The Webex SDK hard-requires H264 in the SDP it negotiates for
  // addMedia() (even for our audio-only, receive-only connection — the video
  // m-line is always present), and Playwright's stock Chromium ships without
  // proprietary codecs. When unset, browser-runtime auto-detects Brave (which
  // bundles H264) before falling back to Playwright's Chromium.
  const browserExecutablePath = trimmed(env.WEBEX_MEETING_BROWSER_EXECUTABLE);

  return {
    browserExecutablePath,
    botToken,
    meetingAccessToken,
    meetingRefreshToken,
    meetingClientId,
    meetingClientSecret,
    canRefreshMeetingToken: Boolean(meetingRefreshToken && meetingClientId && meetingClientSecret),
    webhookBaseUrl: webhookBaseUrl.replace(/\/+$/, ''),
    webhookSecret,
    pollIntervalMs,
    joinTimeoutMs,
  };
}

module.exports = { getConfig, DEFAULT_POLL_INTERVAL_MS, DEFAULT_JOIN_TIMEOUT_MS };
