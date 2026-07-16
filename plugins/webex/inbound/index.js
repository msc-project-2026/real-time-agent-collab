// ********* INBOUND/INDEX.JS *********
'use strict';

const { handleInboundWebexMessage } = require('./message');
const { handleInboundWebexAttachmentAction } = require('./attachment-actions');

/// Inbound webhook handler
async function handleInboundWebexWebhook(payload, ctx) {
  const { account, log } = ctx;

  if (payload.resource === 'messages' && payload.event === 'created') {
    return handleInboundWebexMessage(payload, ctx);
  }

  if (payload.resource === 'attachmentActions' && payload.event === 'created') {
    return handleInboundWebexAttachmentAction(payload, ctx);
  }

  log?.info?.(`[webex:${account.accountId}] ignored webhook payload`, {
    resource: payload.resource,
    event: payload.event,
  });
}

module.exports = {
  handleInboundWebexWebhook,
  handleInboundWebexMessage,
  handleInboundWebexAttachmentAction,
};
