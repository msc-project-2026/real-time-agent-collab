// Inbound message filtering, membership checks, and agent pipeline dispatch.
'use strict';

const { webexFetch } = require('./api');
const { getAccessToken } = require('./token');
const { buildMsgBody } = require('./send');

// Holds the OpenClaw plugin runtime (set via setRuntime() by register() in index.js).
let pluginRuntime = null;
function setRuntime(r) {
  pluginRuntime = r;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function backoffDelay(attempt) {
  const base = 300 * 2 ** (attempt - 1);
  return Math.min(base + Math.random() * base * 0.5, 5000);
}

// OpenClaw rejects concurrent dispatches to the same sessionKey with a
// "reply session initialization conflicted" error (e.g. this inbound
// message racing a collab-sync notification for the same room). Retry
// with backoff so both deliveries land instead of one being dropped.
async function dispatchWithRetry(dispatch, args, { maxAttempts = 5 } = {}) {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await dispatch(args);
    } catch (err) {
      const isSessionConflict = /session initialization conflicted/i.test(
        err?.message ?? ''
      );
      if (!isSessionConflict || attempt === maxAttempts) throw err;
      await sleep(backoffDelay(attempt));
    }
  }
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

  // *** Addition: only process messages from spaces where the bot is a member
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

  // Context payload consumed by the OpenClaw agent pipeline.
  // IsMentioned is delivered as a signal for the agent, not used to gate here.
  const ctxPayload = {
    Body: msg.text ?? '',
    RawBody: msg.text ?? '',
    CommandBody: msg.text ?? '',
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
    IsMentioned: isMentioned,
    RoomId: msg.roomId,
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
  await dispatchWithRetry(dispatch, {
    ctx: ctxPayload,
    cfg: loadedCfg,
    dispatcherOptions: {
      deliver: async (out) => {
        log?.info?.(`[webex:${account.accountId}] raw out.text: ${JSON.stringify(out?.text)}`); //for debugging purposes
        const text = out?.text ?? '';
        const match = text.match(/^\s*DECISION:\s*(SPEAK|SILENT)\s*\n?([\s\S]*)$/i);

        if (!match) {
          log?.warn?.(
            `[webex:${account.accountId}] reply missing DECISION tag, suppressing`
          );
          return;
        }

        const [, decision, body] = match;
        if (decision.toUpperCase() !== 'SPEAK') return;

        const reply = body.trim();
        if (!reply) return;

        await webexFetch(cfg.token, '/messages', {
          method: 'POST',
          body: buildMsgBody(msg.roomId, { text: reply }, msg.parentId),
        });
      },
      onError: (err) => {
        log?.error?.(
          `[webex:${account.accountId}] reply dispatch error: ${err?.message ?? err}`
        );
      },
    },
    replyOptions: {},
  });
}

module.exports = { handleInbound, isDmAllowed, setRuntime };
