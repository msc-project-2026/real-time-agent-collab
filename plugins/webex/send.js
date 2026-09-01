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

// Per-space outbound override — the eval harness's capture seam.
//
// `sendFn` injection cannot reach every sender: when the respond step's model
// calls the shared `message` tool, channel.js supplies its own `sendFn` and
// there is no parameter the harness can thread in. Its send then hits real
// Webex, 404s against a synthetic room, and throws before the recording step
// below is reached — so the agent's own replies never entered the thread
// window, and any scenario where it speaks more than once was being evaluated
// against a transcript in which it stayed silent.
//
// A module-level seam consulted *inside* the senders catches all of them
// uniformly, the model's tool call included. It is scoped per spaceId so it
// can never intercept a real space: the gateway serves live Webex rooms while
// a scenario runs, and eval space ids decode to `:eval/ROOM/` URNs that no
// real room can match.
//
// Keyed by spaceId rather than held in a single slot. It was one slot, and
// two scenarios run concurrently silently destroyed each other's results: the
// second registration replaced the first, so the first run's sends fell
// through to real Webex, 401'd against the eval account's sentinel token, and
// its bundle came back with an empty `sends` array. Nothing failed loudly —
// the run completed, wrote a bundle, and the response judge then scored every
// question 1 for "no reply was sent". Different scenarios use different
// spaceIds, so keying by space makes concurrent runs correct instead of
// merely forbidden; two runs of the *same* scenario still collide, but they
// already collide on the shared eval space directory.
const outboundOverrides = new Map(); // spaceId -> fn

function setOutboundOverride(entry) {
  // Clearing without a spaceId drops everything, preserving the old
  // `setOutboundOverride(null)` teardown call.
  if (!entry) {
    outboundOverrides.clear();
    return;
  }
  const { spaceId, fn } = entry;
  if (!spaceId) throw new Error('setOutboundOverride requires a spaceId');
  if (fn) outboundOverrides.set(spaceId, fn);
  else outboundOverrides.delete(spaceId);
}

function getOutboundOverride(spaceId) {
  if (spaceId === undefined) {
    return outboundOverrides.size === 0 ? null : Object.fromEntries(outboundOverrides);
  }
  return outboundOverrides.get(spaceId) ?? null;
}

// The one place that owns override semantics. Both senders below call it, so
// neither can drift out of sync with the other.
function resolveOutboundSender({ spaceId, sendFn = sendWebexMessage }) {
  if (spaceId && outboundOverrides.has(spaceId)) {
    return outboundOverrides.get(spaceId);
  }
  return sendFn;
}

// Send-time recording (response-policy revision, phase 2): every sender in
// this plugin — the model's own replies via channel.js, and this plugin's
// own deterministic sends (config/task cards, task-notify's ack, the
// thinking placeholder) — goes through this instead of calling `sendFn`
// directly, so recording is never something a caller has to remember or
// reimplement. Recording reuses the exact same appendMessageToThreadWindow
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
  const send = resolveOutboundSender({ spaceId, sendFn });
  // spaceId/botId are passed through for the override's benefit — it needs
  // botId to stamp the synthetic message as bot-authored, so the recording
  // below routes it to `processed` rather than treating it as a user turn.
  // sendWebexMessage destructures only what it needs and ignores both.
  const msg = await send({ ...sendParams, spaceId, botId });

  if (recordToThread && botId) {
    await appendMessageToThreadWindow({ spaceId, message: msg, botId, log, fetchMessageById }).catch(
      (err) => log?.warn?.(`failed to record outbound message: ${err?.message ?? err}`)
    );
  }

  return msg;
}

module.exports = {
  buildMsgBody,
  sendWebexMessage,
  sendOutboundMessage,
  resolveReplyThreadId,
  resolveOutboundSender,
  setOutboundOverride,
  getOutboundOverride,
};
