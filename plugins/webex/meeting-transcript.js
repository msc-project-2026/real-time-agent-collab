'use strict';

const { webexFetch } = require('./api');
const { getAccessToken } = require('./token');

// This handler no longer calls the agent pipeline directly — it POSTs to
// OpenClaw's own /hooks endpoint, which resolves the request through the
// `meeting-notes` entry in hooks.mappings (config/openclaw.json) and routes
// it to the meeting-notes agent. No pluginRuntime/setRuntime wiring needed
// here anymore — that was only required for the old direct
// dispatchReplyWithBufferedBlockDispatcher approach.

const GATEWAY_PORT = process.env.OPENCLAW_GATEWAY_PORT || 18789;
const HOOKS_URL = `http://127.0.0.1:${GATEWAY_PORT}/hooks/meeting-notes`;

// Webex meetingTranscripts/created webhook payload.data shape, per docs:
//   { id: transcriptId, meetingId, scheduledMeetingId, meetingSeriesId, siteUrl, ... }
// UNVERIFIED against a real payload — log it raw below and adjust field
// access if the actual shape differs once this fires for real.
async function handleMeetingTranscript(payload, { cfg, account, log }) {
  if (payload.resource !== 'meetingTranscripts' || payload.event !== 'created') return;

  log?.info?.(`[webex:meeting] transcript webhook data: ${JSON.stringify(payload.data)}`);

  const transcriptId = payload.data?.id;
  const meetingId = payload.data?.meetingId;
  if (!transcriptId || !meetingId) {
    log?.warn?.('[webex:meeting] webhook missing transcriptId/meetingId, skipping');
    return;
  }

  const token = getAccessToken() ?? cfg.token;

  // Meeting metadata — need the topic, and ideally a roomId telling us which
  // space to post notes into. UNVERIFIED: does meeting.roomId exist for
  // ad-hoc space meetings? Falls back to a configured default room if not.
  let meeting;
  try {
    meeting = await webexFetch(token, `/meetings/${meetingId}`);
  } catch (err) {
    log?.error?.(`[webex:meeting] failed to fetch meeting ${meetingId}: ${err?.message}`);
    return;
  }

  const roomId = meeting?.roomId ?? cfg.defaultMeetingNotesRoomId;
  if (!roomId) {
    log?.warn?.(`[webex:meeting] no roomId resolvable for meeting ${meetingId}, skipping`);
    return;
  }

  let transcriptText;
  try {
    const res = await fetch(
      `https://webexapis.com/v1/meetingTranscripts/${transcriptId}/download?format=txt`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    transcriptText = await res.text();
  } catch (err) {
    log?.error?.(`[webex:meeting] failed to download transcript ${transcriptId}: ${err?.message}`);
    return;
  }

  // Hand off to the meeting-notes agent via OpenClaw's hooks ingress.
  // UNVERIFIED: exact required field set for a *named* mapping
  // (POST /hooks/<name>) vs the generic /hooks/agent shape shown in the
  // docs. This follows the generic shape ({ message, to, channel, ... })
  // since the meeting-notes mapping doesn't define its own messageTemplate.
  // The mapping's sessionKey template "{{meetingId}}" needs `meetingId` as
  // a top-level field in this body to resolve correctly — confirm against
  // real logs once this fires.
  const hooksToken = process.env.OPENCLAW_WEBHOOK_SECRET;
  if (!hooksToken) {
    log?.error?.('[webex:meeting] OPENCLAW_WEBHOOK_SECRET not set, cannot dispatch to hooks');
    return;
  }

  try {
    const res = await fetch(HOOKS_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${hooksToken}`,
      },
      body: JSON.stringify({
        message: transcriptText,
        meetingId,
        roomId,
        to: `webex:${roomId}`,
        channel: 'webex',
      }),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`HTTP ${res.status}: ${text}`);
    }

    log?.info?.(`[webex:meeting] dispatched meeting ${meetingId} to hooks/meeting-notes`);
  } catch (err) {
    log?.error?.(
      `[webex:${account.accountId}] failed to dispatch meeting notes hook: ${err?.message ?? err}`
    );
  }
}

module.exports = { handleMeetingTranscript };