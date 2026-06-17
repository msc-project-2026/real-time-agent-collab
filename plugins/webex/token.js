// OAuth access token state, refresh logic, and Webex webhook registration/deregistration.
'use strict';

const { WEBEX_API, webexFetch } = require('./api');

// Current OAuth access token — updated by the 12-day refresh interval in startAccount.
// Falls back to cfg.token (bot token) when null.
let currentAccessToken = null;

function getAccessToken() { return currentAccessToken; }
function setAccessToken(t) { currentAccessToken = t; }

async function refreshAccessToken(cfg) {
  const params = new URLSearchParams({
    grant_type: 'refresh_token',
    client_id: cfg.clientId,
    client_secret: cfg.clientSecret,
    refresh_token: cfg.refreshToken,
  });
  const res = await fetch(`${WEBEX_API}/access_token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params.toString(),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Webex token refresh → ${res.status}: ${text}`);
  }
  const data = await res.json();
  return data.access_token;
}

// Deregisters any existing webhooks pointing at cfg.webhookUrl then creates a
// fresh one.  Idempotent — safe to call on every startAccount.
async function ensureWebhook(cfg) {
  const token = currentAccessToken ?? cfg.token;
  const data = await webexFetch(token, '/webhooks');
  await Promise.all(
    (data?.items ?? [])
      .filter((w) => w.targetUrl === cfg.webhookUrl)
      .map((w) => webexFetch(token, `/webhooks/${w.id}`, { method: 'DELETE' }))
  );
  await webexFetch(token, '/webhooks', {
    method: 'POST',
    body: {
      name: 'OpenClaw Message Handler',
      targetUrl: cfg.webhookUrl,
      resource: 'messages',
      event: 'created',
      ...(cfg.webhookSecret ? { secret: cfg.webhookSecret } : {}),
    },
  });
}

async function deregisterWebhooks(cfg) {
  const token = currentAccessToken ?? cfg.token;
  const data = await webexFetch(token, '/webhooks');
  await Promise.all(
    (data?.items ?? [])
      .filter((w) => w.targetUrl === cfg.webhookUrl)
      .map((w) => webexFetch(token, `/webhooks/${w.id}`, { method: 'DELETE' }))
  );
}

module.exports = { getAccessToken, setAccessToken, refreshAccessToken, ensureWebhook, deregisterWebhooks };
