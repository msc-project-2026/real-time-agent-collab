'use strict';

// Per-room conversation lull tracker.
//
// Implements the "speak at breakpoints" finding from Iqbal & Bailey (2006) /
// the Oasis framework: proactive responses held until the room has been quiet
// for `windowMs`, so the agent never interrupts a rapid-fire exchange.
// Direct mentions bypass this entirely (see inbound.js).

// Map<roomId, lastMessageAt (ms epoch)>
const lastSeen = new Map();

function recordMessage(roomId) {
  lastSeen.set(roomId, Date.now());
}

const POLL_INTERVAL_MS = 500;

// Resolves when either:
//   (a) the room has been quiet for at least windowMs, or
//   (b) maxWaitMs has elapsed since this call (safety valve).
function waitForLull(roomId, { windowMs = 8000, maxWaitMs = 30000 } = {}) {
  return new Promise((resolve) => {
    const startedAt = Date.now();

    const check = () => {
      const last = lastSeen.get(roomId) ?? 0;
      const silentFor = Date.now() - last;
      const waitedTotal = Date.now() - startedAt;

      if (silentFor >= windowMs || waitedTotal >= maxWaitMs) {
        resolve();
      } else {
        setTimeout(check, POLL_INTERVAL_MS);
      }
    };

    check();
  });
}

// Returns the epoch ms of the last recorded message in this room, or 0 if none.
// Used by inbound.js to detect long silences for threshold re-activation.
function getLastSeen(roomId) {
  return lastSeen.get(roomId) ?? 0;
}

module.exports = { recordMessage, waitForLull, getLastSeen };
