// Registers/deregisters this plugin's own Webex webhook subscriptions.
// Deliberately separate from plugins/webex/token.js's WEBHOOK_SPECS — this
// plugin owns its own path prefix and its own subscriptions so it can be
// ported without touching the primary webex plugin.
//
// meetings/started and meetings/ended are registered under the *meeting*
// account (it's the identity that actually joins/leaves), messages/created
// under the *bot* account (it's the identity members already talk to).
// Both accounts are space members so either could technically see either
// resource — this split just matches capability to intent.
'use strict';

const { webexFetch } = require('./api');

function specs(cfg) {
  return [
    { name: 'webex-meeting-join: meeting started', resource: 'meetings', event: 'started', pathSuffix: '/meetings-started', token: cfg.meetingToken },
    { name: 'webex-meeting-join: meeting ended', resource: 'meetings', event: 'ended', pathSuffix: '/meetings-ended', token: cfg.meetingToken },
    { name: 'webex-meeting-join: message created', resource: 'messages', event: 'created', pathSuffix: '/messages-created', token: cfg.botToken },
  ];
}

// Idempotent — deletes any existing webhook at the same targetUrl, then
// recreates it. Safe to call on every gateway_start.
async function ensureWebhooks(cfg) {
  for (const spec of specs(cfg)) {
    const targetUrl = `${cfg.webhookBaseUrl}${spec.pathSuffix}`;
    const existing = await webexFetch(spec.token, '/webhooks');
    const stale = (existing?.items ?? []).filter((w) => w.targetUrl === targetUrl);
    await Promise.all(stale.map((w) => webexFetch(spec.token, `/webhooks/${w.id}`, { method: 'DELETE' })));
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
    const existing = await webexFetch(spec.token, '/webhooks').catch(() => null);
    const stale = (existing?.items ?? []).filter((w) => w.targetUrl === targetUrl);
    await Promise.all(
      stale.map((w) => webexFetch(spec.token, `/webhooks/${w.id}`, { method: 'DELETE' }).catch(() => null))
    );
  }
}

module.exports = { specs, ensureWebhooks, deregisterWebhooks };
