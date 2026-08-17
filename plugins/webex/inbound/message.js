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
const { handleRoutingDispatchResult } = require('../routing/result-handler');
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

// *** Hydrated Webex Message Handler
// Called with a fully-hydrated Webex message object (id, roomId, text, personId, etc.).
// Runs the shared pipeline: thread context → bot filter → routing → batch append/staging.
// Used by both the real inbound handler (after fetching from /messages/:id) and the
// synthetic evaluation runner (which builds hydrated message objects from scenario JSON).
async function handleHydratedWebexMessage({
  message,
  botId,
  account,
  log,
  fetchMessageById,
  sendFn,
}) {
  // Thread handling
  const { threadKey } = await appendMessageToThreadContextWindow({
    spaceId: message.roomId,
    message,
    log,
    fetchMessageById,
  });

  message.threadKey = threadKey;

  const thread = await getThread({
    spaceId: message.roomId,
    threadKey,
    excludeMessageIds: [message.id], // Exclude current message we just appended
  });

  // Skip routing bot messages
  if (message.personId === botId) {
    log?.info?.(`[webex] ignoring bot message`);
    return;
  }

  // Routing: dispatch to the configured routing agent for classification.
  const routingInstruction = buildRoutingInstruction({
    message,
    botId,
    thread,
  });

  const baseSessionKey = `agent:${getRoutingAgentId()}:webex:${message.roomId}:msg-routing`;

  function buildMessageRoutingCtxPayload(sessionKeySuffix) {
    return {
      Body: '',
      RawBody: '',
      CommandBody: routingInstruction,
      From: `webex:${message.personId}`,
      To: `webex:${message.roomId}`,
      SessionKey: sessionKeySuffix
        ? `${baseSessionKey}:${sessionKeySuffix}`
        : baseSessionKey,
      WebexRoomId: message.roomId,
      AccountId: account.accountId,
      ChatType: message.roomType === 'direct' ? 'direct' : 'group',
      SenderName: message.personEmail ?? message.personId,
      SenderId: message.personId,
      Provider: 'webex',
      Surface: 'webex',
      MessageSid: message.id,
      Timestamp: message.created,
      OriginatingChannel: 'webex',
      OriginatingTo: `webex:${message.roomId}`,
      MessageThreadId: message.parentId,
    };
  }

  // onAgentOutput: warn when the routing agent produces text instead of calling the tool.
  // onSessionComplete: consume the validated route result after the session settles.
  await dispatchToAgentForSpace({
    pluginRuntime: getPluginRuntime(),
    spaceId: message.roomId,
    account,
    log,
    buildCtxPayload: buildMessageRoutingCtxPayload,
    onAgentOutput: ({ text }) => {
      log?.warn?.(
        `[webex:${account.accountId}] routing agent produced text instead of tool call — ignoring`,
        { spaceId: message.roomId, text: text?.slice(0, 200) }
      );
    },
    onSessionComplete: () =>
      handleRoutingDispatchResult({
        spaceId: message.roomId,
        message,
        account,
        log,
        sendFn,
      }),
  });
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

  await handleHydratedWebexMessage({
    message: msg,
    botId,
    account,
    log,
    fetchMessageById: (messageId) => webexFetch(token, `/messages/${messageId}`),
  });
}

module.exports = {
  isDmAllowed,
  handleInboundWebexMessage,
  handleHydratedWebexMessage,
};
