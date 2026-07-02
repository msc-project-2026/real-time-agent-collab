'use strict';

// Per-(room, sender) debounce to collapse rapid-fire message bursts.
//
// When someone types in bursts (multiple messages in a few seconds), running the
// gate on each independently could queue multiple responses. Instead we accept the
// first message of a burst and silently skip the rest until the window expires.
// Context and lull tracking still happen for every message — only gate + dispatch
// are gated by this debounce.

const DEBOUNCE_MS = 3500;

// Map<"roomId:senderId", lastAcceptedAt (ms)>
const lastAccepted = new Map();

// Returns true if this message should proceed to gate + dispatch.
// Returns false if it falls within the debounce window of a prior message
// from the same sender in the same room.
function tryAccept(roomId, senderId) {
  const key = `${roomId}:${senderId}`;
  const now = Date.now();
  const last = lastAccepted.get(key) ?? 0;

  if (now - last < DEBOUNCE_MS) return false;

  lastAccepted.set(key, now);
  return true;
}

module.exports = { tryAccept };
