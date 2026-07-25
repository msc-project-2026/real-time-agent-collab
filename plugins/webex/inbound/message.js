// ********* INBOUND/MESSAGE.JS *********
'use strict';

// Inbound message filtering, membership checks, and agent pipeline dispatch.
const { webexFetch } = require('../api');
const { getAccessToken } = require('../token');
const { buildRoutingInstruction } = require('../routing/instruction');
const { dispatchToAgentForSpace } = require('../dispatch');
const { makeRouteResultHandler } = require('../routing/result-handler');
const { getPluginRuntime } = require('../runtime');
const {
  isMeetingControlCommand,
  isMeetingPolicyCommand,
  isMeetingSlashCommand,
  stripLeadingAddress,
} = require('../meeting-command');

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
  { botId, botName, cfg, account, log }
) {
  if (payload.resource !== 'messages' || payload.event !== 'created') return;

  // Ignore messages sent by the bot itself
  if (payload.data?.personId === botId) {
    log?.info?.(`[webex:${account.accountId}] ignoring bot message`);
    return;
  }

  // Apply DM policy for direct messages
  if (payload.data?.roomType === 'direct') {
    if (!isDmAllowed(cfg, payload.data.personId, payload.data.personEmail))
      return;
  }

  // Webhooks only carry IDs — fetch full message to get text + mentions
  const msg = await webexFetch(
    getAccessToken() ?? cfg.token,
    `/messages/${payload.data.id}`
  );

  // Filter: only process messages from spaces where the bot is a member
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

  const isMentioned =
    Array.isArray(msg.mentionedPeople) && msg.mentionedPeople.includes(botId);

  // Meeting join/leave/status and durable join-policy commands are executed by
  // the webex-meeting-join plugin, which sees the same message through its own
  // webhook. Early-return them so the batch pipeline doesn't also produce a
  // reply from an agent that has no meeting state. Addressing rules mirror the
  // meeting plugin's: control commands need an @mention or a bot-name prefix;
  // policy phrases ("never join meetings") and slash commands count unaddressed.
  const text = msg.text ?? '';
  const isAddressed =
    isMentioned ||
    (botName != null && stripLeadingAddress(text, botName) !== text.trim());
  if (
    (isAddressed && isMeetingControlCommand(text, botName)) ||
    isMeetingPolicyCommand(text, botName) ||
    isMeetingSlashCommand(text, botName)
  ) {
    log?.info?.(
      `[webex:${account.accountId}] meeting command delegated to meeting-join plugin (roomId=${msg.roomId})`
    );
    return;
  }

  const contextHeader = {
    spaceId: msg.roomId,
    messageId: msg.id,
    senderId: msg.personId,
    senderName: msg.personEmail ?? msg.personId,
    createdAt: msg.created,
    roomType: msg.roomType,
    isMentioned,
  };

  const routingInstruction = buildRoutingInstruction({ message: msg, botId });

  const baseSessionKey = `agent:main:webex:${msg.roomId}:msg-routing`;

  // Build context payload
  function buildRealWebexCtxPayload(sessionKeySuffix) {
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
