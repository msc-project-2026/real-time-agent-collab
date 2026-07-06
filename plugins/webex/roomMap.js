'use strict';

// Maps an active Webex meetingId to the Webex space (roomId) where the agent
// should post its reactions.
//
// Why explicit binding instead of resolving it from the API: Webex meeting
// objects don't consistently expose a stable "linked space" field across
// meeting types (personal room vs. scheduled vs. space-initiated meetings),
// and getting this wrong silently means replies go nowhere. Binding it
// explicitly — via a `/collab bind-meeting <meetingId>` command run in the
// target space — is one command's worth of friction in exchange for
// certainty about where output lands.

// Map<meetingId, roomId>
const bindings = new Map();

function bind(meetingId, roomId) {
  bindings.set(meetingId, roomId);
}

function unbind(meetingId) {
  bindings.delete(meetingId);
}

function resolveRoom(meetingId) {
  return bindings.get(meetingId) ?? null;
}

module.exports = { bind, unbind, resolveRoom };
