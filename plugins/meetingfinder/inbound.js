// Handles inbound `meetings` / `started` webhook events: gate → dedupe → resolve
// join link → persist. This plugin's whole job stops at "here's the join link" —
// no join automation happens here.
'use strict';

const { getAccessToken } = require('./token');
const { shouldResolve } = require('./gate');
const { alreadyHandled, markHandled } = require('./dedupe');
const { resolveWebLink } = require('./meeting-lookup');
const { recordJoinLink } = require('./store');

async function handleInbound(payload, { cfg, log }) {
  if (payload?.resource !== 'meetings' || payload?.event !== 'started') return;

  log?.info?.(`[meetingfinder] raw payload: ${JSON.stringify(payload)}`);

  const data = payload.data ?? {};
  const meetingId = data.id;
  if (!meetingId) {
    log?.warn?.('[meetingfinder] started event with no meeting id, skipping');
    return;
  }


  const roomId = data.roomId;

  if (!shouldResolve(roomId, cfg)) {
    log?.info?.(`[meetingfinder] roomId=${roomId} not in allowlist, skipping`);
    return;
  }

  if (alreadyHandled(meetingId)) {
    log?.info?.(`[meetingfinder] meetingId=${meetingId} already handled, skipping`);
    return;
  }
  markHandled(meetingId);

  const token = getAccessToken() ?? cfg.accessToken ?? cfg.token;

  let joinLink;
  try {
    joinLink = await resolveWebLink(token, meetingId);
  } catch (err) {
    log?.warn?.(`[meetingfinder] failed to resolve join link for ${meetingId}: ${err?.message}`);
    return;
  }

  await recordJoinLink({
    meetingId,
    meetingNumber: data.meetingNumber,
    roomId,
    title: data.title,
    start: data.start,
    joinLink,
  });

  log?.info?.(`[meetingfinder] resolved join link for meetingId=${meetingId} roomId=${roomId}: ${joinLink}`);
}

module.exports = { handleInbound };