// ********* INBOUND/MEMBERSHIP.JS *********
'use strict';

// Webex delivers the full membership object inline on this webhook (unlike
// messages/attachmentActions, which are id-only and require a follow-up
// fetch) — so no API call is needed here, just a check against the deleted
// membership's personId.
const fs = require('node:fs/promises');
const { spaceDir } = require('../storage/paths');

async function handleInboundWebexMembershipDeleted(
  payload,
  { botId, account, log }
) {
  if (payload.resource !== 'memberships' || payload.event !== 'deleted')
    return;

  const { roomId, personId } = payload.data ?? {};
  if (!roomId || !personId) return;

  // Someone else being removed from the space isn't our concern — only the
  // bot's own removal means this space's collab storage is now orphaned.
  if (personId !== botId) return;

  log?.info?.(
    `[webex:${account.accountId}] bot removed from space, cleaning up ${JSON.stringify(
      { roomId }
    )}`
  );

  await fs.rm(spaceDir(roomId), { recursive: true, force: true });
}

module.exports = {
  handleInboundWebexMembershipDeleted,
};
