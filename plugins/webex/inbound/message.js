// ********* INBOUND/MESSAGE.JS *********
'use strict';

// Inbound message filtering, membership checks, and agent pipeline dispatch.
const { webexFetch } = require('../api');
const { getAccessToken } = require('../token');
const {
  appendMessageToThreadWindow,
  getPendingSlice,
  markThreadMessagesProcessed,
} = require('../context/threads-store');
const { appendPendingMessage } = require('../batch/append');
const { handleStagePendingBatchRequest } = require('../batch/staging-handler');
const { handleConfigRequest } = require('../config/handle-request');
const { dispatchTaggingGate } = require('../tagging/dispatch');
const { decideDispatch } = require('../tagging/decide');
const { runFlowSpike } = require('../tagging/flow-spike');
const { getPluginRuntime, getPluginConfig } = require('../runtime');

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
// Runs the shared pipeline: thread context → bot filter → tagging gate →
// deterministic dispatch (v3 §5) → config flow / existing batch+processing dispatch.
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
  const { threadKey } = await appendMessageToThreadWindow({
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

  // v3 §4 tagging gate — the sole classification call. Awaited: its output
  // (or `null` on failure) feeds deterministic dispatch (§5) below, replacing
  // the routing LLM classifier (phase 3). It never throws.
  const pluginRuntime = getPluginRuntime();

  const tagResult = await dispatchTaggingGate({
    pluginRuntime,
    spaceId,
    threadKey,
    message,
    log,
  });

  // v3 phase 4: Task Flow API spike, run only when explicitly enabled via
  // config. Fire-and-forget — never awaited, never touches dispatch below.
  if (getPluginConfig().taskFlowSpikeEnabled) {
    runFlowSpike({ pluginRuntime, spaceId, threadKey, message, log }).catch(
      () => {}
    );
  }

  const botIsMentioned =
    Array.isArray(message.mentionedPeople) && message.mentionedPeople.includes(botId);

  const decision = decideDispatch({ tagResult, botIsMentioned });

  // The one anchor line for understanding this message's outcome without
  // Control UI visibility into the tagging-gate session itself (it doesn't
  // appear there — see tagging/dispatch.js). Ties the gate's raw judgment to
  // the deterministic action actually taken; full gate diagnostics
  // (toolCallAttempts, reason text) live in the tagging validation log.
  log?.info?.(
    `[collab-agent:inbound-message] dispatch decision ${JSON.stringify({
      spaceId,
      threadKey,
      messageId: message.id,
      gateRan: Boolean(tagResult),
      gateIsMentioned: tagResult?.messageTags?.isMentioned ?? null,
      gateConfigRequest: tagResult?.messageTags?.configRequest ?? null,
      gateReady: tagResult?.pendingThreadWindowDecision?.ready ?? null,
      botIsMentioned,
      finalIsMentioned: decision.finalIsMentioned,
      configRequest: decision.configRequest,
      shouldProcess: decision.shouldProcess,
    })}`
  );

  // Baseline capture: every accepted message still enters the existing batch
  // pipeline (context/threads-store's pending window is a separate, per-thread
  // concern from this per-space batch file that processing reads from).
  await appendPendingMessage({ spaceId, message });

  if (decision.configRequest) {
    await handleConfigRequest({ spaceId, account, log, sendFn });
  }

  // v3 §5: mention or ready flushes the thread's pending slice and spawns
  // processing, immediately — no debounce. Still calls into the existing
  // batch staging + conv-processing/item-extraction dispatch underneath
  // (phase 3 replaces only the trigger decision, not that pipeline).
  if (decision.shouldProcess) {
    const pendingSlice = await getPendingSlice({ spaceId, threadKey });
    const messageIds = pendingSlice.map((entry) => entry.id);

    if (messageIds.length > 0) {
      await markThreadMessagesProcessed({ spaceId, threadKey, messageIds });
    }

    await handleStagePendingBatchRequest({ spaceId, account, log });
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
