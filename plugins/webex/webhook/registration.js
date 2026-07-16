// ********* WEBHOOK/REGISTRATION.JS *********
'use strict';

const { webexFetch } = require('../api');
const { getAccessToken } = require('../token');

// Deregisters (deletes) any existing webhooks pointing at cfg.webhookUrl then creates a
// fresh set.  Idempotent (safe to call on every startAccount).
async function ensureWebhooks(cfg) {
  // const token = getAccessToken() ?? cfg.token;
  const token = account.config?.token;
  const data = await webexFetch(token, '/webhooks');

  await Promise.all(
    (data?.items ?? [])
      .filter((w) => w.targetUrl === cfg.webhookUrl)
      .map((w) => webexFetch(token, `/webhooks/${w.id}`, { method: 'DELETE' }))
  );

  const secret = cfg.webhookSecret ? { secret: cfg.webhookSecret } : {};

  const messageWebhook = await webexFetch(token, '/webhooks', {
    method: 'POST',
    body: {
      name: 'OpenClaw Message Handler',
      targetUrl: cfg.webhookUrl,
      resource: 'messages',
      event: 'created',
      ...secret,
    },
  });

  const actionWebhook = await webexFetch(token, '/webhooks', {
    method: 'POST',
    body: {
      name: 'Openclaw Card Action Handler',
      targetUrl: cfg.webhookUrl,
      resource: 'attachmentActions',
      event: 'created',
      ...secret,
    },
  });

  console.log(
    `[webex] webhooks registered ${JSON.stringify({
      messageWebhookId: messageWebhook.id,
      actionWebhookId: actionWebhook.id,
      targetUrl: cfg.webhookUrl,
    })}`
  );

  const after = await webexFetch(token, '/webhooks');

  console.log(
    '[webex] matching webhooks after registration',
    JSON.stringify(
      (after?.items ?? [])
        .filter((w) => w.targetUrl === cfg.webhookUrl)
        .map((w) => ({
          id: w.id,
          name: w.name,
          resource: w.resource,
          event: w.event,
          targetUrl: w.targetUrl,
          status: w.status,
        }))
    )
  );
}

// Deregisters (deletes) any existing webhooks pointing at cfg.webhookUrl.
async function deregisterWebhooks(cfg) {
  // const token = getAccessToken() ?? cfg.token;
  const token = account.config?.token;
  const data = await webexFetch(token, '/webhooks');
  await Promise.all(
    (data?.items ?? [])
      .filter((w) => w.targetUrl === cfg.webhookUrl)
      .map((w) => webexFetch(token, `/webhooks/${w.id}`, { method: 'DELETE' }))
  );
}

module.exports = {
  ensureWebhooks,
  deregisterWebhooks,
};
