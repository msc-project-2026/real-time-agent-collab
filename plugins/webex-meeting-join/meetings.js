// Meeting-resource helpers: classify meeting kind, resolve an SDK join
// destination, list active meetings for the startup/poll reconciliation
// fallback, and check space membership before joining.
'use strict';

// Webex's Unified Space Meetings migration removed roomId/spaceId as a valid
// SDK join destination entirely (error 30105). The REST meeting object gives
// us the human attendee URL as `webLink`; use that exact link with the SDK's
// MEETING_LINK destination type. The webhook itself only reliably carries the
// meeting id, so callers fetch the full meeting before resolving this value.
function classifyMeetingKind(meeting) {
  const type = String(meeting?.meetingType ?? '').toLowerCase();
  if (type === 'meeting') return 'instant';
  if (type === 'scheduledmeeting') return 'scheduled';
  if (type === 'meetingseries') return 'series';
  return 'unknown';
}

// Prefer the same HTTPS meeting link a human clicks. `meetingLink` and
// `joinLink` cover alternate upstream response shapes. A meeting id is the
// first non-link fallback; SIP is retained only for records that expose
// neither a human link nor an id. Never fall back to roomId/spaceId.
function resolveDestination(meeting) {
  const webLink = [meeting?.webLink, meeting?.meetingLink, meeting?.joinLink]
    .find((value) => typeof value === 'string' && /^https:\/\//i.test(value.trim()));
  if (webLink) {
    return { destination: webLink.trim(), type: 'MEETING_LINK' };
  }
  if (typeof meeting?.id === 'string' && meeting.id) {
    return { destination: meeting.id, type: 'MEETING_ID' };
  }
  if (typeof meeting?.sipUrl === 'string' && meeting.sipUrl) {
    return { destination: meeting.sipUrl, type: 'SIP_URI' };
  }
  if (typeof meeting?.sipAddress === 'string' && meeting.sipAddress) {
    return { destination: meeting.sipAddress, type: 'SIP_URI' };
  }
  throw new Error('meeting has no human webLink, meeting id, or SIP address');
}

async function fetchMeetingWithRetry(meetingFetch, meetingId, { attempts = 3, delayMs = 1500 } = {}) {
  let lastErr;
  for (let i = 0; i < attempts; i += 1) {
    try {
      return await meetingFetch(`/meetings/${encodeURIComponent(meetingId)}`);
    } catch (err) {
      lastErr = err;
      // Webhook delivery can race the meeting record becoming readable via
      // REST; back off and retry a few times before giving up.
      if (i < attempts - 1) await new Promise((r) => setTimeout(r, delayMs));
    }
  }
  throw lastErr;
}

async function isRoomMember(meetingFetch, roomId, personId) {
  if (!roomId || !personId) return false;
  const query = new URLSearchParams({ roomId, personId });
  const result = await meetingFetch(`/memberships?${query}`);
  return Boolean(result?.items?.length);
}

function isActiveMeeting(meeting) {
  const state = String(meeting?.state ?? meeting?.status ?? '').toLowerCase();
  return ['inprogress', 'started', 'active'].includes(state) ||
    Boolean(meeting?.actualStart && !meeting?.actualEnd);
}

// Startup/poll reconciliation: list meetings visible to the meeting account
// in a recent window, used as a fallback when a `meetings/started` webhook
// was missed (delivery failure, webhook subscription lapsed, gateway was
// down when the meeting started).
async function listActiveMeetings(meetingFetch, now = Date.now()) {
  const query = new URLSearchParams({
    from: new Date(now - 10 * 60 * 1000).toISOString(),
    to: new Date(now + 60 * 60 * 1000).toISOString(),
    max: '100',
  });
  const result = await meetingFetch(`/meetings?${query}`);
  return (result?.items ?? []).filter(isActiveMeeting);
}

module.exports = {
  classifyMeetingKind,
  resolveDestination,
  fetchMeetingWithRetry,
  isRoomMember,
  isActiveMeeting,
  listActiveMeetings,
};
