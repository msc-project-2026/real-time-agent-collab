// In-memory tracking of joined meetings, per-meeting join/leave concurrency
// guards, and user-requested "don't rejoin this one" suppression.
//
// Everything here is process-local by design: on a gateway restart the
// startup reconciliation sweep (see orchestrator.js) rebuilds it from Webex's
// own REST state rather than from a persisted snapshot, so there's no
// on-disk state file to go stale or corrupt.
'use strict';

class MeetingState {
  constructor() {
    this.joined = new Map(); // meetingId -> { roomId, kind, joinedAt }
    this.suppressed = new Set(); // meetingId the user explicitly asked us to leave
    this.inFlight = new Map(); // meetingId -> Promise (join or leave in progress)
  }

  isJoined(meetingId) {
    return this.joined.has(meetingId);
  }

  isSuppressed(meetingId) {
    return this.suppressed.has(meetingId);
  }

  markJoined(meetingId, info) {
    this.joined.set(meetingId, { ...info, joinedAt: Date.now() });
    this.suppressed.delete(meetingId);
  }

  markLeft(meetingId, { suppress = false } = {}) {
    this.joined.delete(meetingId);
    if (suppress) this.suppressed.add(meetingId);
  }

  findJoinedByRoom(roomId) {
    for (const [meetingId, info] of this.joined) {
      if (info.roomId === roomId) return { meetingId, ...info };
    }
    return null;
  }

  // Coalesces concurrent operations on the same meetingId (e.g. a retried
  // webhook delivery racing the startup reconciliation sweep) into one call,
  // so we never attempt to double-join or double-leave.
  async withLock(meetingId, fn) {
    const existing = this.inFlight.get(meetingId);
    if (existing) return existing;
    const task = fn().finally(() => {
      this.inFlight.delete(meetingId);
    });
    this.inFlight.set(meetingId, task);
    return task;
  }
}

module.exports = { MeetingState };
