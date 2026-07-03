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
      return job();
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

  // Context payload consumed by the OpenClaw agent pipeline.
  const ctxPayload = {
    Body: msg.text ?? '',
    RawBody: msg.text ?? '',
    CommandBody: [
      routingInstruction,
      '',
      'Webex message context:',
      '```json',
      JSON.stringify(contextHeader, null, 2),
      '```',
      '',
      'Inbound message:',
      msg.text ?? '',
    ].join('\n'),

    From: `webex:${msg.personId}`,
    To: `webex:${msg.roomId}`,
    SessionKey: `agent:main:webex:${msg.roomId}`,

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

  const dispatch =
    pluginRuntime?.channel?.reply?.dispatchReplyWithBufferedBlockDispatcher;
  if (!dispatch) {
    log?.warn?.(
      `[webex:${account.accountId}] agent pipeline dispatch unavailable`
    );
    return;
  }

  const loadedCfg = pluginRuntime.config?.current?.() ?? {};
  await enqueueSpaceDispatch(msg.roomId, () =>
    dispatch({
      ctx: ctxPayload,
      cfg: loadedCfg,
      dispatcherOptions: {
        deliver: async (out) => {
          if (!out.text) return;
          log?.info?.(
            `[webex:${account.accountId}] agent output suppressed: ${out.text}`
          );
          /*        
          await webexFetch(cfg.token, '/messages', {
            method: 'POST',
            body: buildMsgBody(msg.roomId, { text: out.text }, msg.parentId),
          });
          */
        },
        onError: (err) => {
          log?.error?.(
            `[webex:${account.accountId}] reply dispatch error: ${err?.message ?? err}`
          );
        },
      },
      replyOptions: {},
    })
  );
}

module.exports = { handleInbound, isDmAllowed, setRuntime };
