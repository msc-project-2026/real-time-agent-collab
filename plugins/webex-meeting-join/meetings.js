// Meeting-resource helpers: classify meeting kind, resolve an SDK join
// destination, list active meetings for the startup/poll reconciliation
// fallback, and check space membership before joining.
'use strict';

// Webex's Unified Space Meetings migration removed roomId/spaceId as a valid
// SDK join destination entirely (error 30105: "Using the space ID as a
// destination is no longer supported"). meetingId or sipUrl are required
// instead — both only obtainable via the REST API, never from the webhook
// payload alone (Webex webhook payloads for `meetings` only reliably carry
// `id`; the rest is UNVERIFIED against a real payload until this fires for
// real — same caveat plugins/webex/meeting-transcript.js already carries for
// the meetingTranscripts resource).
function classifyMeetingKind(meeting) {
  const type = String(meeting?.meetingType ?? '').toLowerCase();
  if (type === 'meeting') return 'instant';
  if (type === 'scheduledmeeting') return 'scheduled';
  if (type === 'meetingseries') return 'series';
  return 'unknown';
}

// Prefers sipUrl (documented as the more reliable USM destination) over
// meetingId. Throws if neither is present — callers must not fall back to
// roomId/spaceId (that's exactly the removed, now-rejected destination
// shape).
function resolveDestination(meeting) {
  if (typeof meeting?.sipUrl === 'string' && meeting.sipUrl) {
    return { destination: meeting.sipUrl, type: 'SIP_URI' };
  }
  if (typeof meeting?.id === 'string' && meeting.id) {
    // UNVERIFIED: the exact `type` string the SDK expects for a bare
    // meetingId destination wasn't confirmed against live docs (samples use
    // a UI dropdown without enumerating every value). Passing `undefined`
    // lets webex.meetings.create() infer the type itself, which is the
    // pattern shown in Webex's own sample app.
    return { destination: meeting.id, type: undefined };
  }
  throw new Error('meeting has no sipUrl or id — cannot resolve a join destination');
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
