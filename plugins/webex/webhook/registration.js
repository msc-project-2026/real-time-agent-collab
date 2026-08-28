// ********* WEBHOOK/REGISTRATION.JS *********
'use strict';

const { webexFetch } = require('../api');
const { getAccessToken } = require('../token');

// *** Helpers

// Idempotent webhook registration
async function ensureWebhook({ token, webhook, log }) {
  if (!token) throw new Error('token is required');
  if (!webhook?.targetUrl) throw new Error('webhook.targetUrl is required');
  if (!webhook?.resource) throw new Error('webhook.resource is required');
  if (!webhook?.event) throw new Error('webhook.event is required');
  if (!webhook?.name) throw new Error('webhook.name is required');

  const existing = await webexFetch(token, '/webhooks');

  const matches = (existing?.items ?? []).filter(
    (w) =>
      w.targetUrl === webhook.targetUrl &&
      w.resource === webhook.resource &&
      w.event === webhook.event
  );

  // Keep one matching webhook if it already exists.
  const [keeper, ...duplicates] = matches;

  for (const duplicate of duplicates) {
    log?.info?.('[webex] deleting duplicate webhook', {
      id: duplicate.id,
      name: duplicate.name,
      targetUrl: duplicate.targetUrl,
      resource: duplicate.resource,
      event: duplicate.event,
    });

    await webexFetch(token, `/webhooks/${duplicate.id}`, {
      method: 'DELETE',
    });
  }

  if (keeper) {
    log?.info?.('[webex] webhook already exists', {
      id: keeper.id,
      name: keeper.name,
      targetUrl: keeper.targetUrl,
      resource: keeper.resource,
      event: keeper.event,
      status: keeper.status,
    });

    return keeper;
  }

  const created = await webexFetch(token, '/webhooks', {
    method: 'POST',
    body: {
      name: webhook.name,
      targetUrl: webhook.targetUrl,
      resource: webhook.resource,
      event: webhook.event,
      ...(webhook.secret ? { secret: webhook.secret } : {}),
    },
  });

  log?.info?.('[webex] created webhook', {
    id: created.id,
    name: created.name,
    targetUrl: created.targetUrl,
    resource: created.resource,
    event: created.event,
    status: created.status,
  });

  return created;
}

function summariseWebhooksForTargets(items, targetUrls) {
  return (items ?? [])
    .filter((w) => targetUrls.includes(w.targetUrl))
    .map((w) => ({
      id: w.id,
      name: w.name,
      resource: w.resource,
      event: w.event,
      targetUrl: w.targetUrl,
      status: w.status,
    }));
}

// *** Ensure webhooks
async function ensureWebhooks({ cfg, account, log }) {
  const botToken = cfg.token;
  const oauthToken = getAccessToken();

  if (!botToken) throw new Error('Webex bot token is required');
  if (!oauthToken) throw new Error('OAuth access token is required');

  if (!cfg.botWebhookUrl) throw new Error('cfg.botWebhookUrl is required');
  if (!cfg.oauthWebhookUrl) throw new Error('cfg.oauthWebhookUrl is required');

  // Ensure bot participation webhook
  const botWebhook = await ensureWebhook({
    token: botToken,
    log,
    webhook: {
      name: 'OpenClaw Bot Action Handler',
      targetUrl: cfg.botWebhookUrl,
      resource: 'attachmentActions',
      event: 'created',
      secret: cfg.webhookSecret,
    },
  });

  // Ensure auth observation webhook
  const oauthWebhook = await ensureWebhook({
    token: oauthToken,
    log,
    webhook: {
      name: 'OpenClaw OAuth Message Observer',
      targetUrl: cfg.oauthWebhookUrl,
      resource: 'messages',
      event: 'created',
      secret: cfg.webhookSecret,
    },
  });

  // Ensure membership-removal webhook — same target/identity as the bot
  // action handler (routes by resource/event, not a separate URL), so the
  // bot can clean up its own per-space storage the moment it's removed from
  // a space rather than that state sitting there forever.
  const membershipWebhook = await ensureWebhook({
    token: botToken,
    log,
    webhook: {
      name: 'OpenClaw Bot Membership Observer',
      targetUrl: cfg.botWebhookUrl,
      resource: 'memberships',
      event: 'deleted',
      secret: cfg.webhookSecret,
    },
  });

  // Ensure membership-addition webhook — same target/identity, sibling to
  // the removal one above. Lets the bot send the config card immediately
  // on being added to a space (inbound/membership.js), instead of waiting
  // for someone to explicitly ask for it — which also means the member
  // cache (config/handle-request.js's refreshCachedMembers) is populated
  // from the start rather than staying empty until the first config
  // request.
  const membershipCreatedWebhook = await ensureWebhook({
    token: botToken,
    log,
    webhook: {
      name: 'OpenClaw Bot Membership Added Observer',
      targetUrl: cfg.botWebhookUrl,
      resource: 'memberships',
      event: 'created',
      secret: cfg.webhookSecret,
    },
  });

  // Log registration
  log?.info?.(
    `[webex:${account.accountId}] webhooks registered ${JSON.stringify({
      botWebhookId: botWebhook.id,
      botWebhookUrl: cfg.botWebhookUrl,
      oauthWebhookId: oauthWebhook.id,
      oauthWebhookUrl: cfg.oauthWebhookUrl,
      membershipWebhookId: membershipWebhook.id,
      membershipCreatedWebhookId: membershipCreatedWebhook.id,
    })}`
  );

  const [botAfter, oauthAfter] = await Promise.all([
    webexFetch(botToken, '/webhooks'),
    webexFetch(oauthToken, '/webhooks'),
  ]);

  log?.info?.(
    `[webex] matching bot-owned webhooks after registration ${JSON.stringify({
      matching: summariseWebhooksForTargets(botAfter?.items, [
        cfg.botWebhookUrl,
        cfg.oauthWebhookUrl,
      ]),
    })}`
  );

  log?.info?.(
    `[webex] matching oauth-owned webhooks after registration ${JSON.stringify({
      matching: summariseWebhooksForTargets(oauthAfter?.items, [
        cfg.botWebhookUrl,
        cfg.oauthWebhookUrl,
      ]),
    })}`
  );

  return {
    botWebhook,
    oauthWebhook,
    membershipWebhook,
    membershipCreatedWebhook,
  };
}

async function deleteWebhooksForTargets({
  token,
  targetUrls,
  log,
  ownerLabel,
}) {
  if (!token) throw new Error('token is required');

  const data = await webexFetch(token, '/webhooks');

  const toDelete = (data?.items ?? []).filter((w) =>
    targetUrls.includes(w.targetUrl)
  );

  for (const webhook of toDelete) {
    log?.info?.('[webex] deleting webhook', {
      ownerLabel,
      id: webhook.id,
      name: webhook.name,
      resource: webhook.resource,
      event: webhook.event,
      targetUrl: webhook.targetUrl,
    });

    await webexFetch(token, `/webhooks/${webhook.id}`, {
      method: 'DELETE',
    });
  }

  return toDelete;
}

// Deregisters known bot-owned and OAuth-owned webhooks for this account.
async function deregisterWebhooks(cfg, { log } = {}) {
  const botToken = cfg.token;
  const oauthToken = getAccessToken();

  const targetUrls = [cfg.botWebhookUrl, cfg.oauthWebhookUrl].filter(Boolean);

  if (targetUrls.length === 0) {
    throw new Error('at least one webhook URL is required');
  }

  const deleted = [];

  if (botToken) {
    deleted.push(
      ...(await deleteWebhooksForTargets({
        token: botToken,
        targetUrls,
        log,
        ownerLabel: 'bot',
      }))
    );
  }

  if (oauthToken) {
    deleted.push(
      ...(await deleteWebhooksForTargets({
        token: oauthToken,
        targetUrls,
        log,
        ownerLabel: 'oauth',
      }))
    );
  }

  return deleted;
}

module.exports = {
  ensureWebhooks,
  deregisterWebhooks,
};
