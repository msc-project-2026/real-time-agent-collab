// ********* SEND.JS *********
'use strict';

const { webexFetch } = require('./api');
const { appendMessageToThreadWindow, getThread, MAIN_THREAD_KEY } = require('./storage/threads-store');

// Webex bots can only see messages that explicitly @-mention them — a real
// platform restriction, distinct from this plugin's own OAuth-based
// "message observer" identity (channel.js), which sees every message for
// classification purposes but never sends. Using a message the bot's own
// token has never seen — or an existing thread's root, which may equally
// be invisible — as `parentId` 400s with "Parent activity ID not found or
// invalid" (or "Cannot reply to a reply" for the config card specifically,
// since it's always sent as a reply to begin with). Decided once, up
// front, rather than reactively retrying after Webex rejects it, so every
// reply-sending call site (config card, respond, task-notify,
// thinking-ack) gets a consistent answer instead of each duplicating the
// same ternary.
//
// Two different mention facts matter here, not one: for the main space,
// the *triggering* message is the candidate root, so its own
// (deterministic) mention status is what's checked. For an existing
// thread, the candidate root is a *different* message — whichever one
// started that thread — so what matters is whether *that* message
// mentions the bot, not the triggering one. Being mentioned in a reply
// several messages deep into a thread doesn't tell you whether the bot's
// token can see that thread's root. `rootBotIsMentioned` is stamped onto
// the thread record once, at creation (storage/threads-store.js's
// root-backfill), from the root's own Webex data — a single stored
// property read here, no per-call fetch or scan.
async function resolveReplyThreadId({ spaceId, explicitRoot, threadKey, message, isBotMentioned }) {
  if (threadKey === MAIN_THREAD_KEY) {
    return isBotMentioned ? message?.id : null;
  }
  const thread = await getThread({ spaceId, threadKey, explicitRoot });
  return thread?.rootBotIsMentioned ? threadKey : null;
}

// Some callers (e.g. OpenClaw core's durable delivery queue) pass targets in
// the generic `<channel>:<id>` form instead of the bare Webex id. Left
// unstripped, the prefix corrupts the base64 decode below and gets sent to
// Webex as a literal roomId, which 404s.
function stripChannelPrefix(to) {
  return to.toLowerCase().startsWith('webex:') ? to.slice(6).trim() : to;
}

// Build a Webex Messages API POST body, inferring roomId vs toPersonId vs email destination.
function buildMsgBody(to, content, parentId) {
  const body = {};

  to = stripChannelPrefix(to);

  if (to.includes('@')) {
    body.toPersonEmail = to;
  } else {
    try {
      const dec = Buffer.from(to, 'base64').toString('utf-8');
      body[dec.includes('/PEOPLE/') ? 'toPersonId' : 'roomId'] = to;
    } catch {
      body.roomId = to;
    }
  }
  if (content.text) body.text = content.text;
  if (content.markdown) body.markdown = content.markdown;
  if (content.files?.length) body.files = [content.files[0]];
  if (content.attachments?.length) body.attachments = content.attachments;
  if (parentId) body.parentId = parentId;
  return body;
}

async function sendWebexMessage({
  token,
  to,
  text,
  markdown,
  files,
  attachments,
  parentId,
}) {
  if (!token) throw new Error('Webex token is required');
  if (!to) throw new Error('message target is required');

  return webexFetch(token, '/messages', {
    method: 'POST',
    body: buildMsgBody(
      to,
      {
        text,
        markdown,
        files,
        attachments,
      },
      parentId
    ),
  });
}

// Send-time recording (response-policy revision, phase 2): every sender in
// this plugin — the model's own replies via channel.js, and this plugin's
// own deterministic sends (config/task cards, task-notify's ack, the
// thinking placeholder) — goes through this instead of calling `sendFn`
// directly, so recording is never something a caller has to remember or
// reimplement. `sendFn` is the thing that actually hits Webex (real by
// default); this function itself is never wrapped or swapped out — only
// `sendFn` is. Recording reuses the exact same appendMessageToThreadWindow
// path inbound messages go through (same threading/root-seeding rules,
// not a parallel implementation) — a bot-authored message routes straight
// to `processed`, never `pending`, via that function's own existing logic.
async function sendOutboundMessage({
  sendFn = sendWebexMessage,
  recordToThread = true,
  spaceId,
  botId,
  fetchMessageById,
  log,
  ...sendParams
}) {
  const msg = await sendFn(sendParams);

  if (recordToThread && botId) {
    await appendMessageToThreadWindow({ spaceId, message: msg, botId, log, fetchMessageById }).catch(
      (err) => log?.warn?.(`failed to record outbound message: ${err?.message ?? err}`)
    );
  }

  return msg;
}

module.exports = { buildMsgBody, sendWebexMessage, sendOutboundMessage, resolveReplyThreadId };
