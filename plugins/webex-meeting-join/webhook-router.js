// HTTP route handler for this plugin's own inbound Webex webhook POSTs.
// Duplicated from plugins/webex/webhook.js's HMAC-verification/ACK-fast
// pattern (not imported) to keep this plugin self-contained. Registered at
// its own path prefix via api.registerHttpRoute, independent of the primary
// webex plugin's /webhooks/webex/ prefix.
'use strict';

const { createHmac, timingSafeEqual } = require('node:crypto');

const MAX_BODY_BYTES = 1024 * 1024;
const ROUTE_PREFIX = '/webhooks/webex-meeting-join';

function normPath(p) {
  const s = String(p ?? '').trim();
  if (!s) return '/';
  const r = s.startsWith('/') ? s : `/${s}`;
  return r.length > 1 && r.endsWith('/') ? r.slice(0, -1) : r;
}

function verifyHmac(secret, rawBody, signature) {
  if (!secret) return true; // no secret configured — skip verification
  if (!signature) return false;
  const mac = createHmac('sha1', secret);
  mac.update(rawBody);
  const expected = Buffer.from(mac.digest('hex'));
  const given = Buffer.from(String(signature));
  if (expected.length !== given.length) return false;
  try {
    return timingSafeEqual(expected, given);
  } catch {
    return false;
  }
}

// Creates a router bound to a fixed webhookSecret and a map of
// pathSuffix -> async handler(payload). Returns { router, ROUTE_PREFIX }.
function createWebhookRouter({ webhookSecret, handlers, log }) {
  async function router(req, res) {
    const path = normPath(new URL(req.url ?? '/', 'http://x').pathname);
    if (!path.startsWith(ROUTE_PREFIX)) return false; // not our path
    const suffix = path.slice(ROUTE_PREFIX.length) || '/';
    const handler = handlers.get(suffix);
    if (!handler) return false;

    if (req.method !== 'POST') {
      res.statusCode = 405;
      res.setHeader('Allow', 'POST');
      res.end('Method Not Allowed');
      return true;
    }

    let rawBody;
    try {
      const chunks = [];
      let size = 0;
      let tooLarge = false;
      for await (const chunk of req) {
        size += chunk.length;
        if (size > MAX_BODY_BYTES) {
          tooLarge = true;
          break;
        }
        chunks.push(chunk);
      }
      if (tooLarge) {
        res.statusCode = 413;
        res.end('Payload Too Large');
        return true;
      }
      rawBody = Buffer.concat(chunks);
    } catch {
      if (!res.headersSent) {
        res.statusCode = 400;
        res.end('Bad Request');
      }
      return true;
    }

    const sig = req.headers['x-spark-signature'];
    if (!verifyHmac(webhookSecret, rawBody, sig)) {
      res.statusCode = 401;
      res.end('Unauthorized');
      return true;
    }

    let payload;
    try {
      payload = JSON.parse(rawBody.toString('utf-8'));
    } catch {
      res.statusCode = 400;
      res.end('Bad Request');
      return true;
    }

    // ACK immediately — Webex requires a fast 200 response, and retries
    // (duplicate deliveries) if it doesn't get one in time.
    res.statusCode = 200;
    res.setHeader('Content-Type', 'application/json');
    res.end('{"ok":true}');

    handler(payload).catch((err) => {
      log?.error?.(`[webex-meeting-join] handler error for ${suffix}: ${err?.message ?? err}`);
    });

    return true;
  }

  return router;
}

module.exports = { createWebhookRouter, verifyHmac, normPath, ROUTE_PREFIX };
