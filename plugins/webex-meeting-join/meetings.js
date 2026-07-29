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

// `GET /meetings` defaults to `meetingType=meetingSeries`, so the default
// query only ever returns *scheduled* meetings — a scheduled space meeting's
// series is listed with state `inProgress` while one of its instances runs.
// An instant ("Meet" in a space / ad-hoc) meeting has no scheduled series: it
// exists only as a meeting instance (`meetingType: "meeting"`), which the
// default query never returns. Ask for both, or instant meetings are
// invisible to every list-based lookup.
const MEETING_LIST_QUERIES = [
  {}, // scheduled series (the API default)
  { meetingType: 'meeting', state: 'inProgress' }, // instant/ad-hoc + running instances
];

// A running scheduled meeting can come back twice: once as its series and
// once as the instance, whose `meetingSeriesId` points back at the series.
// Collapse those onto one candidate so callers don't read it as two
// concurrent meetings in the space and refuse to guess between them. An
// instant meeting's parent is never listed, so it survives as itself.
function meetingGroupKey(meeting) {
  return String(meeting?.meetingSeriesId ?? meeting?.id ?? '');
}

function dedupeMeetings(meetings) {
  const byKey = new Map();
  for (const meeting of meetings) {
    const key = meetingGroupKey(meeting);
    // First writer wins, and the series query is listed first, so the
    // scheduled path keeps joining the same object it always has.
    if (key && !byKey.has(key)) byKey.set(key, meeting);
  }
  return Array.from(byKey.values());
}

// Startup/poll reconciliation and the explicit `/meeting join` lookup: list
// meetings visible to the meeting account in a recent window. Used as a
// fallback when a `meetings/started` webhook was missed (delivery failure,
// webhook subscription lapsed, gateway was down when the meeting started).
async function listActiveMeetings(
  meetingFetch,
  now = Date.now(),
  { lookbackMs = 10 * 60 * 1000, lookaheadMs = 60 * 60 * 1000 } = {}
) {
  const window = {
    from: new Date(now - lookbackMs).toISOString(),
    to: new Date(now + lookaheadMs).toISOString(),
    max: '100',
  };
  const results = await Promise.allSettled(MEETING_LIST_QUERIES.map((extra) =>
    meetingFetch(`/meetings?${new URLSearchParams({ ...window, ...extra })}`)
  ));
  // A site that rejects one query variant must not blind us to the other;
  // only a total failure is worth reporting to the caller.
  if (results.every((result) => result.status === 'rejected')) throw results[0].reason;

  const items = results.flatMap((result) =>
    result.status === 'fulfilled' ? (result.value?.items ?? []) : []
  );
  // Filter before deduping: if a series looks idle but its instance is live,
  // the live instance is the candidate we want to keep.
  return dedupeMeetings(items.filter(isActiveMeeting));
}

module.exports = {
  classifyMeetingKind,
  resolveDestination,
  fetchMeetingWithRetry,
  isRoomMember,
  isActiveMeeting,
  listActiveMeetings,
};
