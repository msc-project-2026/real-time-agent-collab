// Meeting-resource helpers: classify meeting kind, resolve an SDK join
// destination, list active meetings for the startup/poll reconciliation
// fallback, and check space membership before joining.
'use strict';

// Webex's Unified Space Meetings migration removed roomId/spaceId as a valid
// SDK join destination entirely (error 30105). Fetch the REST meeting object
// and join with its SDK-facing `sipUrl`/`sipAddress`, falling back to its
// `id`. `webLink` is an attendee-browser URL, not the migration target: using
// it selects the SDK's legacy MEETING_LINK lookup and can produce a Locus join
// error even though the linked meeting is otherwise valid.
function classifyMeetingKind(meeting) {
  const type = String(meeting?.meetingType ?? '').toLowerCase();
  if (type === 'meeting') return 'instant';
  if (type === 'scheduledmeeting') return 'scheduled';
  if (type === 'meetingseries') return 'series';
  return 'unknown';
}

// Webex's Unified Space Meetings migration specifies the REST meeting's SIP
// URL/address or meeting ID as the Browser SDK destination. Do not prefer the
// attendee-facing HTTPS webLink: the SDK treats that as its legacy
// MEETING_LINK lookup path. Never fall back to roomId/spaceId.
function resolveDestination(meeting) {
  if (typeof meeting?.sipUrl === 'string' && meeting.sipUrl.trim()) {
    return { destination: meeting.sipUrl.trim(), type: 'SIP_URI' };
  }
  if (typeof meeting?.sipAddress === 'string' && meeting.sipAddress.trim()) {
    return { destination: meeting.sipAddress.trim(), type: 'SIP_URI' };
  }
  if (typeof meeting?.id === 'string' && meeting.id.trim()) {
    return { destination: meeting.id.trim(), type: 'MEETING_ID' };
  }
  throw new Error('meeting has no SDK meeting id or SIP address');
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
async function listActiveMeetings(
  meetingFetch,
  now = Date.now(),
  { lookbackMs = 10 * 60 * 1000, lookaheadMs = 60 * 60 * 1000 } = {}
) {
  const query = new URLSearchParams({
    from: new Date(now - lookbackMs).toISOString(),
    to: new Date(now + lookaheadMs).toISOString(),
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
