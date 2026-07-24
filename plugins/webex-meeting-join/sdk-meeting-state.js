'use strict';

function normalizeReference(value) {
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  const normalized = String(value).trim().toLowerCase();
  return normalized || null;
}

function meetingReferences(meeting) {
  return new Set([
    meeting?.id,
    meeting?.destination,
    meeting?.meetingLink,
    meeting?.sipUri,
    meeting?.sipUrl,
    meeting?.locusUrl,
    meeting?.meetingInfo?.meetingId,
    meeting?.meetingInfo?.sipUri,
    meeting?.meetingInfo?.sipUrl,
    meeting?.meetingInfo?.sipAddress,
    meeting?.meetingInfo?.webLink,
    meeting?.meetingInfo?.locusUrl,
    meeting?.locusInfo?.url,
  ].map(normalizeReference).filter(Boolean));
}

function referenceValues(reference) {
  const ref = typeof reference === 'string'
    ? { sdkMeetingId: reference, meetingId: reference }
    : reference ?? {};
  return new Set([
    ref.sdkMeetingId,
    ref.meetingId,
    ref.destination,
    ref.meetingLink,
    ref.sipUri,
    ref.sipUrl,
    ref.locusUrl,
  ].map(normalizeReference).filter(Boolean));
}

function joinedDevice(meeting) {
  return meeting?.joinedWith
    ?? meeting?.locusInfo?.parsedLocus?.self?.joinedWith
    ?? meeting?.locusInfo?.self?.joinedWith
    ?? null;
}

// This deliberately checks the SDK device selected for this browser, not
// merely the account-level self.state. The same Webex user may be in a
// meeting on another client, which must not make this browser look joined.
function activeOnThisDevice(meeting) {
  try {
    if (typeof meeting?.isJoined === 'function' && meeting.isJoined()) return true;
  } catch {
    // Fall through to the public Locus-derived fields.
  }

  const device = joinedDevice(meeting);
  const state = String(device?.state ?? '').toUpperCase();
  if (state === 'JOINED') return true;

  // A device waiting in a lobby is still present and must remain leaveable.
  const intent = String(device?.intent?.type ?? '').toUpperCase();
  return ['WAIT', 'OBSERVE'].includes(intent) && !['LEFT', 'DECLINED'].includes(state);
}

function intersects(left, right) {
  for (const value of left) if (right.has(value)) return true;
  return false;
}

// Prefer an exact identifier match that is active on this browser. If Webex
// rebuilt the Meeting object with different identifiers after sync, accept a
// sole active local meeting as a conservative fallback. Never guess between
// multiple active calls.
function findMeeting(reference, meetings, { activeOnly = false } = {}) {
  const list = Array.from(meetings ?? []).filter(Boolean);
  const wanted = referenceValues(reference);
  const exact = list.filter((meeting) => intersects(wanted, meetingReferences(meeting)));
  const exactActive = exact.find(activeOnThisDevice);
  if (exactActive) return exactActive;
  if (!activeOnly && exact.length) return exact[0];

  const active = list.filter(activeOnThisDevice);
  return active.length === 1 ? active[0] : null;
}

module.exports = {
  activeOnThisDevice,
  findMeeting,
  joinedDevice,
  meetingReferences,
  referenceValues,
};
