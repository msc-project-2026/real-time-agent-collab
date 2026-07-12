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

// CONFIRMED via live testing: the roomId filter finds meetings that were
// SCHEDULED through the space itself. It returns nothing for meetings started
// via the client's "Start meeting" button (confirmed empty with a bare query
// and a real token — not a state/meetingType param issue, the room
// association genuinely doesn't exist for that creation path). The optional
// "Rooms" field in the scheduling UI was NOT what made this work — it was
// never used in the test that succeeded; scheduled-through-the-space vs.
// started-instantly is the actual distinguishing factor.
//
// Finds the currently active meeting in a given room, if any. Returns null if
// nothing is found.
async function findActiveMeetingForRoom(token, roomId) {
  const params = new URLSearchParams({ roomId });
  const res = await webexFetch(token, `/meetings?${params.toString()}`);
  const items = res?.items ?? [];
  if (items.length === 0) return null;

  if (items.length > 1) {
    return { ambiguous: true, candidates: items };
  }

  const meeting = items[0];
  return {
    ambiguous: false,
    meetingId: meeting.id,
    meetingNumber: meeting.meetingNumber,
    hostEmail: meeting.hostEmail,
    state: meeting.state,
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

// There is no meeting→roomId field anywhere in the Meetings API — confirmed:
// GET /meetings/{meetingId} doesn't return roomId even for a meeting that WAS
// found via the roomId filter above. The only direction that works is
// roomId→meeting, and only for meetings scheduled through a space.
//
// So this reverses it the only way possible: check each candidate room's
// active meeting and see if it's the same meeting. Matches on meetingNumber,
// not meetingId — confirmed live that the started webhook's meetingId carries
// an "_I_<instance>" suffix that the roomId-filtered lookup's meetingId does
// NOT have, even for the exact same meeting. meetingNumber is identical in
// both representations, so it's the only reliable match key across the two.
//
// O(n) in the number of candidate rooms — cheap for a handful of rooms
// (rooms.js's listRoomIds), not something to run against hundreds unbatched.
// Returns null if no candidate room's active meeting matches — the expected/
// normal outcome for a meeting that was started instantly rather than
// scheduled through a space.
async function findRoomIdForMeeting(token, meetingNumber, candidateRoomIds) {
  for (const roomId of candidateRoomIds) {
    let result;
    try {
      result = await findActiveMeetingForRoom(token, roomId);
    } catch {
      continue; // one room's query failing shouldn't abort the scan
    }
    if (result && !result.ambiguous && result.meetingNumber === meetingNumber) {
      return roomId;
    }
  }
  return null;
}

module.exports = { resolveWebLink, findActiveMeetingForRoom, findRoomIdForMeeting };