// ********* INBOUND/MESSAGE.JS *********
'use strict';

// Inbound message filtering, membership checks, and agent pipeline dispatch.
const { webexFetch } = require('../api');
const { getAccessToken } = require('../token');
const { appendMessageToThreadWindow } = require('../context/threads-store');
const { runMessageFlow } = require('../flow/run-message-flow');

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
// Runs the shared pipeline: thread context → bot filter → one managed Task
// Flow per message (gate → deterministic dispatch → config/respond, v3 phase 5).
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
  const spaceId = message.roomId;

  // Thread handling — the message is durably stored as `pending` before
  // anything downstream runs (v3 §3), regardless of what dispatch decides.
  const { threadKey, pendingCount } = await appendMessageToThreadWindow({
    spaceId,
    message,
    botId,
    log,
    fetchMessageById,
  });

  message.threadKey = threadKey;

  // Skip bot's own messages
  if (message.personId === botId) {
    log?.info?.(`[collab-agent:inbound-message] ignoring bot message`);
    return;
  }

  // v3 phase 5: one managed Task Flow per message, gate as its first step,
  // respond (if triggered) as its second — see flow/run-message-flow.js.
  await runMessageFlow({
    spaceId,
    threadKey,
    message,
    botId,
    pendingCount,
    account,
    log,
    sendFn,
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
    log?.info?.(
      `[collab-agent:inbound-message] ignoring duplicate message ${JSON.stringify({
        messageId: payload.data?.id,
      })}`
    );
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
