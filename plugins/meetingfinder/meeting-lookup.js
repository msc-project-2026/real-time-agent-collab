// Resolves the human-style join link (the same j.php?MTID=... URL shown in a
// meeting invitation) via GET /meetings/{meetingId}.
//
// Previously also called POST /meetings/join for a second, SDK/programmatic-style
// link (integrationJoinToken-based) — dropped after testing showed that link is
// short-lived and tied to a specific identity, neither of which apply to the
// MTID-style webLink returned here.
'use strict';

const { webexFetch } = require('./api');

const RETRY_DELAY_MS = 4000;


async function findActiveMeetingForRoom(token, roomId) {
  const params = new URLSearchParams({ roomId, state: 'active', meetingType: 'meeting' });
  const res = await webexFetch(token, `/meetings?${params.toString()}`);
  const items = res?.items ?? [];
  if (items.length === 0) return null;

  // Room-scoped ad-hoc meetings are capped at one active instance per room
  // (Create a Meeting's docs: "There's only one ad-hoc meeting for a room at
  // the same time"), so for the instant-meeting case this shouldn't need
  // disambiguation. If more than one comes back, that assumption didn't hold —
  // surface all of them rather than silently picking one.
  if (items.length > 1) {
    return { ambiguous: true, candidates: items };
  }

  const meeting = items[0];
  return {
    ambiguous: false,
    meetingId: meeting.id,
    meetingNumber: meeting.meetingNumber,
    hostEmail: meeting.hostEmail,
    webLink: meeting.webLink ?? (await resolveWebLink(token, meeting.id).catch(() => null)),
  };
}

async function resolveWebLink(token, meetingId, { retried = false } = {}) {
  try {
    const meeting = await webexFetch(token, `/meetings/${meetingId}`);
    if (!meeting?.webLink) throw new Error('no webLink in response');
    return meeting.webLink;
  } catch (err) {
    // Webhook → REST sync isn't always instant (Webex documents this as within
    // ~10 minutes for 99.5% of cases) — one retry covers the common short lag.
    if (retried) throw err;
    await new Promise((r) => setTimeout(r, RETRY_DELAY_MS));
    return resolveWebLink(token, meetingId, { retried: true });
  }
}

module.exports = { resolveWebLink, findActiveMeetingForRoom };