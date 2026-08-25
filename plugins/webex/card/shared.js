// ********* CARD/SHARED.JS *********
'use strict';

// Common Adaptive Card infrastructure shared by config/card.js and
// task-card/dispatch.js. Domain-specific card *building* (what fields, what
// actions) stays in each domain's own module — this is only the generic
// "format a value for display" helper and the "here's a card, send it as a
// Webex message attachment" plumbing both domains would otherwise duplicate.

const { sendWebexMessage } = require('../send');

function valueOrEmpty(value) {
  return value == null ? '' : String(value);
}

async function sendAdaptiveCard({
  spaceId,
  account,
  log,
  markdown,
  card,
  parentId,
  sendFn = sendWebexMessage,
}) {
  if (!spaceId) throw new Error('spaceId is required');
  if (!account) throw new Error('account is required');
  if (!card) throw new Error('card is required');

  const token = account.config?.token;
  if (!token) throw new Error('Webex token is required');

  const msg = await sendFn({
    token,
    to: spaceId,
    markdown,
    attachments: [
      {
        contentType: 'application/vnd.microsoft.card.adaptive',
        content: card,
      },
    ],
    parentId,
  });

  log?.info?.(`[collab-agent:card] card sent ${JSON.stringify({ spaceId, messageId: msg.id })}`);

  return { ok: true, spaceId, messageId: msg.id };
}

module.exports = {
  valueOrEmpty,
  sendAdaptiveCard,
};
