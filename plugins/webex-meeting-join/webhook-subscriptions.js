// Registers/deregisters this plugin's own Webex webhook subscriptions.
// Deliberately separate from plugins/webex/token.js's WEBHOOK_SPECS — this
// plugin owns its own path prefix and its own subscriptions so it can be
// ported without touching the primary webex plugin.
//
// All three webhooks are registered under the *meeting* account.
// meetings/started and meetings/ended because it's the identity that
// actually joins/leaves. messages/created must ALSO use the meeting account
// (a real user, which receives every message in its spaces) rather than the
// bot: Webex only delivers messages/created to a bot when the bot is
// @mentioned in a group space or in a 1:1, so the natural-language join
// policy phrases ("never join meetings"), which are accepted without an
// @mention, would never arrive on a bot-token webhook. The meeting account
// is a member of exactly the spaces where auto-join is possible, so the
// subscription covers the right rooms.
'use strict';

const { webexFetch } = require('./api');

function specs(cfg) {
  return [
    { name: 'webex-meeting-join: meeting started', resource: 'meetings', event: 'started', pathSuffix: '/meetings-started', token: cfg.meetingToken },
    { name: 'webex-meeting-join: meeting ended', resource: 'meetings', event: 'ended', pathSuffix: '/meetings-ended', token: cfg.meetingToken },
    { name: 'webex-meeting-join: message created', resource: 'messages', event: 'created', pathSuffix: '/messages-created', token: cfg.meetingToken },
  ];
}

// A webhook is only visible to the account that created it, so stale
// registrations at our targetUrls are swept under BOTH tokens — earlier
// versions registered messages/created under the bot account, and leaving
// that behind would double-deliver @mention messages.
function cleanupTokens(cfg, spec) {
  return [...new Set([spec.token, cfg.meetingToken, cfg.botToken].filter(Boolean))];
}

async function deleteAtTargetUrl(token, targetUrl, { swallowErrors = false } = {}) {
  const existing = await webexFetch(token, '/webhooks').catch((err) => {
    if (swallowErrors) return null;
    throw err;
  });
  const stale = (existing?.items ?? []).filter((w) => w.targetUrl === targetUrl);
  await Promise.all(
    stale.map((w) =>
      webexFetch(token, `/webhooks/${w.id}`, { method: 'DELETE' }).catch((err) => {
        if (swallowErrors) return null;
        throw err;
      })
    )
  );
}

// Idempotent — deletes any existing webhook at the same targetUrl, then
// recreates it. Safe to call on every gateway_start.
async function ensureWebhooks(cfg) {
  for (const spec of specs(cfg)) {
    const targetUrl = `${cfg.webhookBaseUrl}${spec.pathSuffix}`;
    for (const token of cleanupTokens(cfg, spec)) {
      await deleteAtTargetUrl(token, targetUrl, { swallowErrors: token !== spec.token });
    }
    await webexFetch(spec.token, '/webhooks', {
      method: 'POST',
      body: {
        name: spec.name,
        targetUrl,
        resource: spec.resource,
        event: spec.event,
        ...(cfg.webhookSecret ? { secret: cfg.webhookSecret } : {}),
      },
    });
  }
}

async function deregisterWebhooks(cfg) {
  for (const spec of specs(cfg)) {
    const targetUrl = `${cfg.webhookBaseUrl}${spec.pathSuffix}`;
    for (const token of cleanupTokens(cfg, spec)) {
      await deleteAtTargetUrl(token, targetUrl, { swallowErrors: true });
    }
  }
}

module.exports = { specs, ensureWebhooks, deregisterWebhooks };
