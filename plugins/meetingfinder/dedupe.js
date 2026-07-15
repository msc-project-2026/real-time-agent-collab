'use strict';

// Prevents re-resolving the same meeting twice — Webex retries webhook delivery on
// failure, and a slow handler + retry could otherwise trigger duplicate lookups.

const TTL_MS = 6 * 60 * 60 * 1000; // 6h — comfortably longer than any single meeting

// Map<meetingId, handledAt (ms)>
const seen = new Map();

function alreadyHandled(meetingId) {
  const at = seen.get(meetingId);
  return Boolean(at && Date.now() - at < TTL_MS);
}

function markHandled(meetingId) {
  seen.set(meetingId, Date.now());
  if (seen.size > 500) {
    const cutoff = Date.now() - TTL_MS;
    for (const [id, at] of seen) if (at < cutoff) seen.delete(id);
  }
}

module.exports = { alreadyHandled, markHandled };
