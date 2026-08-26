// ********* SEND.JS *********
'use strict';

const { webexFetch } = require('./api');
const { appendMessageToThreadWindow } = require('./storage/threads-store');

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

module.exports = { buildMsgBody, sendWebexMessage, sendOutboundMessage };
