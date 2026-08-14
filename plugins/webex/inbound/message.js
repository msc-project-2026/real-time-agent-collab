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
const { getPluginRuntime, getRoutingAgentId } = require('../runtime');

// 30-second deduplication window — Webex may deliver the same webhook event twice.
const seenMessageIds = new Set();
function isDuplicate(messageId) {
  if (!messageId || seenMessageIds.has(messageId)) return true;
  seenMessageIds.add(messageId);
  setTimeout(() => seenMessageIds.delete(messageId), 30_000);
  return false;
}

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

  // Drop duplicates before any API calls — Webex may redeliver the same event.
  if (isDuplicate(payload.data?.id)) {
    log?.info?.(`[webex:${account.accountId}] ignoring duplicate message`, {
      messageId: payload.data?.id,
    });
    return;
  }

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
    log,
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

  // Routing: dispatch to the configured routing agent for classification.
  const routingInstruction = buildRoutingInstruction({
    message: msg,
    botId,
    thread,
  });

  const baseSessionKey = `agent:${getRoutingAgentId()}:webex:${msg.roomId}:msg-routing`;

  function buildMessageRoutingCtxPayload(sessionKeySuffix) {
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
    buildCtxPayload: buildMessageRoutingCtxPayload,
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
