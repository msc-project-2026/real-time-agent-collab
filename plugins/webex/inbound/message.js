// ********* INBOUND/MESSAGE.JS *********
'use strict';

// Inbound message filtering, membership checks, and agent pipeline dispatch.
const { webexFetch } = require('../api');
const { getAccessToken } = require('../token');
const {
  appendMessageToThreadContextWindow,
  getThread,
} = require('../context/threads-store');
const { buildRoutingInstruction } = require('../routing/instruction');
const { dispatchToAgentForSpace } = require('../dispatch');
const { makeRouteResultHandler } = require('../routing/result-handler');
const { getPluginRuntime } = require('../runtime');
const { spaceDir } = require('../storage/paths');

// DmPolicy enforcement
function isDmAllowed(cfg, personId, personEmail) {
  switch (cfg.dmPolicy) {
    case 'allow':
      return true;
    case 'deny':
      return false;
    case 'allowlisted': {
      const list = cfg.allowFrom ?? [];
      return list.includes(personId) || list.includes(personEmail);
    }
    default:
      return false;
  }
}

// *** Inbound Webex Message Handler
// Called asynchronously after the webhook POST is acknowledged.  Filters,
// fetches full message details, then dispatches to the OpenClaw agent pipeline.
async function handleInboundWebexMessage(
  payload,
  { botId, cfg, account, log }
) {
  if (payload.resource !== 'messages' || payload.event !== 'created') return;

  // Get token
  const token = getAccessToken() ?? cfg.token;
  if (!token) throw new Error('Webex token is required');

  // Webhooks only carry IDs — fetch full message to get text + mentions
  if (!payload.data?.id) return;

  const msg = await webexFetch(token, `/messages/${payload.data.id}`);

  // Apply DM policy for direct messages
  if (msg.roomType === 'direct') {
    if (!isDmAllowed(cfg, msg.personId, msg.personEmail)) return;
  }

  // Filter: only handle messages from spaces where the bot is a member
  let membership;
  try {
    membership = await webexFetch(
      cfg.token,
      `/memberships?roomId=${msg.roomId}&personId=${botId}`
    );
  } catch {
    return; // bot not in this space or no access — skip silently
  }
  if (!membership?.items?.length) return;

  // Thread handling
  const { threadKey } = await appendMessageToThreadContextWindow({
    spaceId: msg.roomId,
    message: msg,
    fetchMessageById: (messageId) =>
      webexFetch(token, `/messages/${messageId}`),
  });

  msg.threadKey = threadKey;

  const thread = await getThread({
    spaceId: msg.roomId,
    threadKey,
    excludeMessageIds: [msg.id], // Exclude current message we just appended
  });

  // Skip routing bot messages
  if (msg.personId === botId) {
    log?.info?.(`[webex:${account.accountId}] ignoring bot message`);
    return;
  }

  // Instruction and session key
  const routingInstruction = buildRoutingInstruction({
    message: msg,
    botId,
    thread,
  });

  const baseSessionKey = `agent:main:webex:${msg.roomId}:msg-routing`;

  // Build context payload
  function buildMessageRoutingWebexCtxPayload(sessionKeySuffix) {
    return {
      Body: msg.text ?? '',
      RawBody: msg.text ?? '',
      CommandBody: routingInstruction,
      From: `webex:${msg.personId}`,
      To: `webex:${msg.roomId}`,
      SessionKey: sessionKeySuffix
        ? `${baseSessionKey}:${sessionKeySuffix}`
        : baseSessionKey,
      WebexRoomId: msg.roomId,
      AccountId: account.accountId,
      ChatType: msg.roomType === 'direct' ? 'direct' : 'group',
      SenderName: msg.personEmail ?? msg.personId,
      SenderId: msg.personId,
      Provider: 'webex',
      Surface: 'webex',
      MessageSid: msg.id,
      Timestamp: msg.created,
      OriginatingChannel: 'webex',
      OriginatingTo: `webex:${msg.roomId}`,
      MessageThreadId: msg.parentId,
    };
  }

  await dispatchToAgentForSpace({
    pluginRuntime: getPluginRuntime(),
    spaceId: msg.roomId,
    account,
    log,
    buildCtxPayload: buildRealWebexCtxPayload,
    onAgentOutput: makeRouteResultHandler({
      message: msg,
      account,
      log,
    }),
  });
}

module.exports = {
  isDmAllowed,
  handleInboundWebexMessage,
};
