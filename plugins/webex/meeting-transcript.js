'use strict';

const { webexFetch } = require('./api');
const { getAccessToken } = require('./token');
const { buildMsgBody } = require('./send');
const { dispatchWithRetry } = require('../../lib/dispatch-retry.js');

let pluginRuntime = null;
function setRuntime(r) {
  pluginRuntime = r;
}

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

  const ctxPayload = {
    Body: transcriptText,
    RawBody: transcriptText,
    CommandBody: transcriptText,
    From: `webex-meetings:${meetingId}`,
    To: `webex:${roomId}`,
    SessionKey: `agent:meeting-notes:webex:${meetingId}`,
    WebexRoomId: roomId,
    AccountId: account.accountId,
    ChatType: 'meeting-transcript',
    SenderName: meeting?.hostDisplayName ?? 'meeting',
    Provider: 'webex-meetings',
    Surface: 'webex-meetings',
    OriginatingChannel: 'webex-meetings',
    OriginatingTo: `webex:${roomId}`,
    MeetingId: meetingId,
    MeetingTopic: meeting?.title,
    RoomId: roomId,
  };

  const dispatch = pluginRuntime?.channel?.reply?.dispatchReplyWithBufferedBlockDispatcher;
  if (!dispatch) {
    log?.warn?.(`[webex:${account.accountId}] agent pipeline unavailable for meeting notes`);
    return;
  }

  await dispatchWithRetry(dispatch, {
    ctx: ctxPayload,
    cfg: pluginRuntime.config?.current?.() ?? {},
    dispatcherOptions: {
      deliver: async (out) => {
        const reply = (out?.text ?? '').trim();
        if (!reply) return;
        await webexFetch(cfg.token, '/messages', {
          method: 'POST',
          body: buildMsgBody(roomId, { text: reply }),
        });
      },
      onError: (err) => {
        log?.error?.(`[webex:${account.accountId}] meeting-notes dispatch error: ${err?.message ?? err}`);
      },
    },
    replyOptions: {},
  });
}

module.exports = { handleMeetingTranscript, setRuntime };