// Inbound message filtering, membership checks, and agent pipeline dispatch.
'use strict';

const { webexFetch } = require('./api');
const { getAccessToken } = require('./token');
const { buildMsgBody } = require('./send');

const { buildRoutingInstruction } = require('./prompts/routing');

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

// Serialise dispatch per Webex space
const dispatchQueues = new Map();
const DISPATCH_SETTLE_DELAY_MS = 500;

function sleep(ms = DISPATCH_SETTLE_DELAY_MS) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function enqueueSpaceDispatch(spaceId, job) {
  const previous = dispatchQueues.get(spaceId) ?? Promise.resolve();

  console.log('[webex] enqueue dispatch', {
    spaceId,
    alreadyQueued: dispatchQueues.has(spaceId),
  });

  const next = previous
    .catch((err) => {
      // Keep the queue alive even if the previous dispatch failed.
      console.warn('[webex] previous dispatch failed; continuing queue', {
        spaceId,
        error: err?.message ?? String(err),
      });
    })
    .then(async () => {
      console.log('[webex] start dispatch', { spaceId });
      try {
        return await job();
      } finally {
        await sleep();
      }
    })
    .finally(() => {
      console.log('[webex] finish dispatch', { spaceId });
      if (dispatchQueues.get(spaceId) === next) {
        dispatchQueues.delete(spaceId);
      }
    });

  dispatchQueues.set(spaceId, next);
  return next;
}

async function dispatchWithSessionConflictRetry(dispatchJob) {
  // On gateway restart, an existing OpenClaw reply session can transiently
  // fail initialization for the canonical room SessionKey. Retry once with a
  // temporary recovery SessionKey so the inbound message is not lost. Later
  // messages still use the canonical SessionKey.
  try {
    return await dispatchJob();
  } catch (err) {
    const message = err?.message ?? String(err);

    if (!message.includes('reply session initialization conflicted')) {
      throw err;
    }

    const recoverySuffix = `recovery-${Date.now()}`;

    console.warn(
      '[webex] reply session conflict; retrying once with recovery session key',
      {
        error: message,
        recoverySuffix,
      }
    );

    await sleep(500);

    return await dispatchJob(recoverySuffix);
  }
}

// Dispatch to agent for space
async function dispatchToAgentForSpace({
  spaceId,
  account,
  log,
  buildCtxPayload,
}) {
  const dispatch =
    pluginRuntime?.channel?.reply?.dispatchReplyWithBufferedBlockDispatcher;
  if (!dispatch) {
    log?.warn?.(
      `[webex:${account.accountId}] agent pipeline dispatch unavailable`
    );
    return;
  }

  const loadedCfg = pluginRuntime.config?.current?.() ?? {};

  await enqueueSpaceDispatch(spaceId, () =>
    dispatchWithSessionConflictRetry((sessionKeySuffix) =>
      dispatch({
        ctx: buildCtxPayload(sessionKeySuffix),
        cfg: loadedCfg,
        dispatcherOptions: {
          deliver: async (out) => {
            if (!out.text) return;
            log?.info?.(
              `[webex:${account.accountId}] agent output suppressed: ${out.text}`
            );
          },
          onError: (err) => {
            log?.error?.(
              `[webex:${account.accountId}] reply dispatch error: ${err?.message ?? err}`
            );
          },
        },
        replyOptions: {},
      })
    )
  );
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
    spaceId: msg.roomId,
    account,
    log,
    buildCtxPayload: buildRealWebexCtxPayload,
  });

  schedulePendingBatchProcessing({
    spaceId: msg.roomId,
    account,
    log,
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
    spaceId,
    account,
    log,
    buildCtxPayload: buildSyntheticProcessPendingBatchCtxPayload,
  });
}

// ****** Scheduler
// Note: timers are in-memory only. They are lost on gateway restart/deploy.
// Recovery scanner to be added later.

const pendingBatchTimers = new Map();
const PENDING_BATCH_DEBOUNCE_MS = 30_000;

function schedulePendingBatchProcessing({ spaceId, account, log }) {
  if (!spaceId) throw new Error('spaceId is required');

  const existing = pendingBatchTimers.get(spaceId);
  if (existing) {
    clearTimeout(existing);
  }

  const timer = setTimeout(async () => {
    pendingBatchTimers.delete(spaceId);

    try {
      await handleTriggerProcessingPendingBatch({
        spaceId,
        account,
        log,
      });
    } catch {
      log?.error?.(
        `[webex:${account.accountId}] pending batch trigger failed: ${err?.message ?? err}`
      );
    }
  }, PENDING_BATCH_DEBOUNCE_MS);

  pendingBatchTimers.set(spaceId, timer);
}

module.exports = {
  setRuntime,
  isDmAllowed,
  handleInbound,
  dispatchToAgentForSpace,
  handleTriggerProcessingPendingBatch,
};
