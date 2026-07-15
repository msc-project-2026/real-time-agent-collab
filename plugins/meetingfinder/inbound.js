// Handles inbound `meetings` / `started` webhook events: dedupe → resolve join
// link → attempt roomId → gate on the result → persist.
//
// Gating had to move to AFTER roomId resolution, not before: the webhook never
// carries roomId, so gating on it up front (before we know the real value)
// would make a non-empty cfg.roomIds allowlist reject everything, since the
// only roomId available at that point is always undefined. Now cfg.roomIds
// serves one coherent purpose — both "candidates to check via reverse lookup"
// and "the allowlist to gate on" — using whatever roomId (or null) the lookup
// actually found.
'use strict';

const { getAccessToken } = require('./token');
const { shouldResolve } = require('./gate');
const { alreadyHandled, markHandled } = require('./dedupe');
const { resolveWebLink, findRoomIdForMeeting } = require('./meeting-lookup');
const { listRoomIds } = require('./rooms');
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

  // Confirmed via testing: the started webhook never carries roomId. Best-effort
  // reverse lookup against every room the account belongs to — discovered
  // dynamically via GET /rooms (cached briefly), no manual config needed. Only
  // finds a match for meetings that were SCHEDULED through one of these
  // spaces; instant/"Start meeting" ones will always come back null here,
  // which is expected, not an error.
  //
  // cfg.roomIds, if set, still works as an explicit restriction (skips
  // dynamic discovery, only checks those specific rooms) — but it's no longer
  // required for roomId resolution to work at all.
  let roomId = null;
  try {
    const candidateRoomIds = cfg.roomIds?.length ? cfg.roomIds : await listRoomIds(token);
    roomId = await findRoomIdForMeeting(token, data.meetingNumber, candidateRoomIds);
  } catch (err) {
    log?.warn?.(`[meetingfinder] roomId reverse lookup failed for ${meetingId}: ${err?.message}`);
  }

  // Now that we know the real roomId (or that it's genuinely unresolvable),
  // gate on it. Empty allowlist = accept regardless. Non-empty allowlist =
  // only accept if the reverse lookup actually matched one of those rooms.
  if (!shouldResolve(roomId, cfg)) {
    log?.info?.(`[meetingfinder] meetingId=${meetingId} roomId=${roomId} not in allowlist, skipping`);
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