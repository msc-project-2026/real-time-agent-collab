// ********* SEND.JS *********
'use strict';

const { webexFetch } = require('./api');

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

module.exports = { buildMsgBody, sendWebexMessage };
