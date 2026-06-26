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
    SessionKey: `webex:${msg.roomId}`,
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
  await dispatch({
    ctx: ctxPayload,
    cfg: loadedCfg,
    dispatcherOptions: {
      deliver: async (out) => {
        if (!out.text) return;
        await webexFetch(cfg.token, '/messages', {
          method: 'POST',
          body: buildMsgBody(msg.roomId, { text: out.text }, msg.parentId),
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
