// ********* INBOUND/INDEX.JS *********
'use strict';

const { handleInboundWebexMessage } = require('./message');
const { handleInboundWebexAttachmentAction } = require('./attachment-actions');
const { handleInboundWebexMembershipDeleted } = require('./membership');

/// Inbound webhook handler
async function handleInboundWebexWebhook(payload, ctx) {
  const { identity, account, log } = ctx;

  log?.info?.(
    `[collab-agent:inbound] inbound webhook payload ${JSON.stringify({
      identity,
      webhookId: payload.id,
      name: payload.name,
      resource: payload.resource,
      event: payload.event,
      dataId: payload.data?.id,
      personEmail: payload.data?.personEmail,
    })}`
  );

  if (
    identity === 'oauth' &&
    payload.resource === 'messages' &&
    payload.event === 'created'
  ) {
    return handleInboundWebexMessage(payload, ctx);
  }

  if (
    identity === 'bot' &&
    payload.resource === 'attachmentActions' &&
    payload.event === 'created'
  ) {
    return handleInboundWebexAttachmentAction(payload, ctx);
  }

  if (
    identity === 'bot' &&
    payload.resource === 'memberships' &&
    payload.event === 'deleted'
  ) {
    return handleInboundWebexMembershipDeleted(payload, ctx);
  }

  log?.info?.(
    `[collab-agent:inbound] ignored webhook payload ${JSON.stringify({
      identity,
      resource: payload.resource,
      event: payload.event,
    })}`
  );
}

module.exports = {
  handleInboundWebexWebhook,
  handleInboundWebexMessage,
  handleInboundWebexAttachmentAction,
  handleInboundWebexMembershipDeleted,
};
