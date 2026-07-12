'use strict';

// Decides whether meetingfinder should resolve a join link for this meeting.
//
// Static config for now — a per-account roomIds allowlist (empty = allow every
// space the account can see). If this needs to become runtime-adjustable later
// (e.g. a `/meetings <mode>` chat command), see plugins/webex/prefs.js for the
// override-tiers pattern already used for the proactivity gate — same shape
// would apply here (user/room override > config default).

function shouldResolve(roomId, cfg) {
  if (!roomId) return false;
  const allowlist = cfg.roomIds ?? [];
  if (allowlist.length === 0) return true;
  return allowlist.includes(roomId);
}

module.exports = { shouldResolve };
