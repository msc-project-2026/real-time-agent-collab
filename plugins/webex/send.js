// Outbound message body builder: infers roomId vs toPersonId vs email destination.
'use strict';

// Build a Webex Messages API POST body, inferring roomId vs toPersonId vs email.
function buildMsgBody(to, content, parentId) {
  const body = {};
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

module.exports = { buildMsgBody };
