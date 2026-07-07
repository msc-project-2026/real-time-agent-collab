// ********* INBOUND.JS *********
'use strict';

// Inbound message filtering, membership checks, and agent pipeline dispatch.
const { webexFetch } = require('./api');
const { getAccessToken } = require('./token');
const { buildMsgBody } = require('./send');
const { buildRoutingInstruction } = require('./prompts/routing');
const { dispatchToAgentForSpace } = require('./dispatch');
const {
  schedulePendingBatchProcessing,
} = require('./scheduling/schedule-batch');

// Holds the OpenClaw plugin runtime (set via setRuntime() by register() in index.js).
let pluginRuntime = null;
function setRuntime(r) {
  pluginRuntime = r;
}

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

// Called asynchronously after the webhook POST is acknowledged.  Filters,
// fetches full message details, then delivers to the OpenClaw agent pipeline.
async function handleInbound(payload, { botId, cfg, account, log }) {
  if (payload.resource !== 'messages' || payload.event !== 'created') return;

  // Ignore messages sent by the bot itself
  if (payload.data?.personId === botId) return;

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

  const contextHeader = {
    spaceId: msg.roomId,
    messageId: msg.id,
    senderId: msg.personId,
    senderName: msg.personEmail ?? msg.personId,
    createdAt: msg.created,
    roomType: msg.roomType,
    isMentioned,
  };

  // Fetch routing instruction
  const routingInstruction = buildRoutingInstruction();

  // Build context payload
  function buildRealWebexCtxPayload(sessionKeySuffix) {
    return {
      Body: msg.text ?? '',
      RawBody: msg.text ?? '',
      CommandBody: [
        routingInstruction,
        '',
        'Webex message context:',
        '',
        '```json',
        JSON.stringify(contextHeader, null, 2),
        '```',
        '',
        'Inbound message:',
        msg.text ?? '',
      ].join('\n'),

      From: `webex:${msg.personId}`,
      To: `webex:${msg.roomId}`,

      SessionKey: sessionKeySuffix
        ? `agent:main:webex:${msg.roomId}:${sessionKeySuffix}`
        : `agent:main:webex:${msg.roomId}`,

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
    pluginRuntime,
    spaceId: msg.roomId,
    account,
    log,
    buildCtxPayload: buildRealWebexCtxPayload,
  });

  schedulePendingBatchProcessing({
    spaceId: msg.roomId,
    account,
    log,
    batchProcessor: handleTriggerProcessingPendingBatch,
  });
}

async function handleTriggerProcessingPendingBatch({ spaceId, account, log }) {
  if (!spaceId) throw new Error('spacedId is required');

  const routingInstruction = buildRoutingInstruction();

  function buildSyntheticProcessPendingBatchCtxPayload(sessionKeySuffix) {
    const syntheticContext = {
      eventType: 'process_pending_batch',
      synthetic: true,
      spaceId,
      createdAt: new Date().toISOString(),
    };

    return {
      Body: '',
      RawBody: '',
      CommandBody: [
        routingInstruction,
        '',
        'Internal synthetic Webex collaboration event:',
        '',
        '```json',
        JSON.stringify(syntheticContext, null, 2),
        '```',
        '',
        'Route this event as process_pending_batch.',
      ].join('\n'),

      From: 'webex:internal-scheduler',
      To: `webex:${spaceId}`,

      SessionKey: sessionKeySuffix
        ? `agent:main:webex:${spaceId}:${sessionKeySuffix}`
        : `agent:main:webex:${spaceId}`,

      WebexRoomId: spaceId,
      AccountId: account.accountId,
      ChatType: 'group',
      SenderName: 'internal-scheduler',
      SenderId: 'internal-scheduler',
      Provider: 'webex',
      Surface: 'webex',
      MessageSid: `synthetic:process_pending_batch:${spaceId}:${Date.now()}`,
      Timestamp: syntheticContext.createdAt,
      OriginatingChannel: 'webex',
      OriginatingTo: `webex:${spaceId}`,
      MessageThreadId: null,
    };
  }

  await dispatchToAgentForSpace({
    pluginRuntime,
    spaceId,
    account,
    log,
    buildCtxPayload: buildSyntheticProcessPendingBatchCtxPayload,
  });
}

module.exports = {
  setRuntime,
  isDmAllowed,
  handleInbound,
  handleTriggerProcessingPendingBatch,
};
