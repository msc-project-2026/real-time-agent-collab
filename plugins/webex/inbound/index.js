// ********* INBOUND/INDEX.JS *********
'use strict';

const { handleInboundWebexMessage } = require('./message');
const { handleInboundWebexAttachmentAction } = require('./attachment-actions');

/// Inbound webhook handler
async function handleInboundWebexWebhook(payload, ctx) {
  const { account, log } = ctx;

  log?.info?.(
    `[webex:${account.accountId}] inbound webhook payload ${JSON.stringify({
      id: payload.id,
      name: payload.name,
      resource: payload.resource,
      event: payload.event,
      dataId: payload.data?.id,
      personEmail: payload.data?.personEmail,
    })}`
  );
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
