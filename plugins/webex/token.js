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

const WEBHOOK_SPECS = [
  { name: 'OpenClaw Message Handler', resource: 'messages', event: 'created', pathSuffix: '' },
  { name: 'OpenClaw Membership Handler', resource: 'memberships', event: 'created', pathSuffix: '' },
  { name: 'OpenClaw Card Action Handler', resource: 'attachmentActions', event: 'created', pathSuffix: '' },
  { name: 'OpenClaw Meeting Transcript Handler', resource: 'meetingTranscripts', event: 'created', pathSuffix: '/meeting-transcripts' },
  
];

async function ensureWebhook(cfg) {
  const token = currentAccessToken ?? cfg.token;
  const data = await webexFetch(token, '/webhooks');
  const existing = data?.items ?? [];

  for (const spec of WEBHOOK_SPECS) {
    const targetUrl = `${cfg.webhookUrl}${spec.pathSuffix}`;
    await Promise.all(
      existing
        .filter((w) => w.targetUrl === targetUrl)
        .map((w) => webexFetch(token, `/webhooks/${w.id}`, { method: 'DELETE' }))
    );
    await webexFetch(token, '/webhooks', {
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
  const token = currentAccessToken ?? cfg.token;
  const data = await webexFetch(token, '/webhooks');
  const urls = new Set(WEBHOOK_SPECS.map((s) => `${cfg.webhookUrl}${s.pathSuffix}`));
  await Promise.all(
    (data?.items ?? [])
      .filter((w) => urls.has(w.targetUrl))
      .map((w) => webexFetch(token, `/webhooks/${w.id}`, { method: 'DELETE' }))
  );
}

module.exports = { getAccessToken, setAccessToken, refreshAccessToken, ensureWebhook, deregisterWebhooks };
