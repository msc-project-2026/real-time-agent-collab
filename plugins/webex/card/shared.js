// ********* CARD/SHARED.JS *********
'use strict';

// Common Adaptive Card infrastructure shared by config/card.js and
// task-card/card.js. Domain-specific card *building* (what fields, what
// actions) stays in each domain's own module — this is only the generic
// "format a value for display" helper, the AdaptiveCard envelope every card
// shares, and the "here's a card, send it as a Webex message attachment"
// plumbing both domains would otherwise duplicate.

const { sendWebexMessage } = require('../send');
const { appendMessageToThreadWindow } = require('../storage/threads-store');

function valueOrEmpty(value) {
  return value == null ? '' : String(value);
}

function buildCardEnvelope({ body, actions }) {
  return {
    type: 'AdaptiveCard',
    version: '1.3',
    body,
    actions,
  };
}

// Cards need their own recording shape, not the plain-message one
// (send.js's sendOutboundMessage) — a card's accompanying `markdown` is
// thin (e.g. config's fixed "Please review this collaboration space
// configuration."), so recording it verbatim would leave a later prompt
// blind to the fact that a card with real content appeared here at all.
// `recordLabel` is a short, caller-supplied description of what the card
// was — recorded in place of the raw markdown, not a structured
// serialization of the card body.
async function sendAdaptiveCard({
  spaceId,
  account,
  botId,
  log,
  markdown,
  card,
  recordLabel,
  parentId,
  fetchMessageById,
  recordToThread = true,
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

  if (recordToThread && botId) {
    await appendMessageToThreadWindow({
      spaceId,
      botId,
      log,
      fetchMessageById,
      message: { ...msg, text: recordLabel ?? markdown },
    }).catch((err) => log?.warn?.(`failed to record outbound card: ${err?.message ?? err}`));
  }

  log?.info?.(`[collab-agent:card] card sent ${JSON.stringify({ spaceId, messageId: msg.id })}`);

  return { ok: true, spaceId, messageId: msg.id };
}

module.exports = {
  valueOrEmpty,
  buildCardEnvelope,
  sendAdaptiveCard,
};
