// ********* INBOUND/MEMBERSHIP.JS *********
'use strict';

// Webex delivers the full membership object inline on this webhook (unlike
// messages/attachmentActions, which are id-only and require a follow-up
// fetch) — so no API call is needed here, just a check against the deleted
// membership's personId.
const fs = require('node:fs/promises');
const { spaceDir } = require('../storage/paths');
const { MAIN_THREAD_KEY } = require('../storage/threads-store');
const { handleConfigRequest } = require('../config/handle-request');

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

// Sends the config card the moment the bot is added to a space, rather than
// waiting for someone to explicitly ask for it — this also means the member
// cache (config/handle-request.js's refreshCachedMembers) is populated from
// the start, instead of staying empty until the first config request.
// There's no triggering message to reply to here, so this posts in the
// main space with no reply target — resolveReplyThreadId/sendConfigCard
// already handle that (message: undefined, isBotMentioned: false resolves
// to null, which posts bare) with no special-casing needed.
async function handleInboundWebexMembershipCreated(
  payload,
  { botId, account, log }
) {
  if (payload.resource !== 'memberships' || payload.event !== 'created')
    return;

  const { roomId, personId } = payload.data ?? {};
  if (!roomId || !personId) return;

  // Someone else joining isn't our concern — only the bot's own addition
  // means this is a space we haven't sent a config card to yet.
  if (personId !== botId) return;

  log?.info?.(
    `[webex:${account.accountId}] bot added to space, sending config card ${JSON.stringify(
      { roomId }
    )}`
  );

  await handleConfigRequest({
    spaceId: roomId,
    threadKey: MAIN_THREAD_KEY,
    message: undefined,
    isBotMentioned: false,
    account,
    botId,
    log,
  });
}

module.exports = {
  handleInboundWebexMembershipDeleted,
  handleInboundWebexMembershipCreated,
};
