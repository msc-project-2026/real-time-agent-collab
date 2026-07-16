// ********* WEBHOOK/ROUTER.JS *********
'use strict';

const {
  handleInboundWebexAttachmentAction,
} = require('../inbound/attachment-actions');

const { createHmac, timingSafeEqual } = require('node:crypto');

const MAX_BODY_BYTES = 1024 * 1024;

// *** Helpers

// Active webhook targets registered by startAccount, keyed by normalized path.
// Each entry: { account, handle(payload) → Promise }
const targets = new Map();

function normPath(p) {
  const s = String(p ?? '').trim();
  if (!s) return '/';
  const r = s.startsWith('/') ? s : `/${s}`;
  return r.length > 1 && r.endsWith('/') ? r.slice(0, -1) : r;
}

// Verify HMAC-SHA1 over the raw request body bytes.
// Returns true when no secret is configured (skip verification).
function verifyHmac(secret, rawBody, signature) {
  if (!secret) return true;
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

// *** HTTP webhook router

// Registered at /webhooks/webex/ (prefix match, auth: plugin).
// Dispatches to the right account target based on the full path.
async function webhookRouter(req, res) {
  console.log(`[webex] webhookRouter called: ${req.method} ${req.url}`);
  const path = normPath(new URL(req.url ?? '/', 'http://x').pathname);
  const target = targets.get(path);
  if (!target) return false; // not our path

  console.log('[webex] webhook target lookup', {
    path,
    knownTargets: Array.from(targets.keys()),
  });

  if (req.method !== 'POST') {
    res.statusCode = 405;
    res.setHeader('Allow', 'POST');
    res.end('Method Not Allowed');
    return true;
  }

  // Read the raw body bytes (needed for HMAC verification)
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

  // Verify HMAC-SHA1 over the raw bytes (not re-stringified JSON)
  const sig = req.headers['x-spark-signature'];
  if (!verifyHmac(target.account.config.webhookSecret, rawBody, sig)) {
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

  // ACK immediately — Webex requires a fast 200 response
  res.statusCode = 200;
  res.setHeader('Content-Type', 'application/json');
  res.end('{"ok":true}');

  target.handle(payload).catch((err) => {
    console.error(
      `[webex:${target.account.accountId}] inbound error: ${err?.message ?? err}`
    );
  });

  return true;
}

module.exports = {
  targets,
  normPath,
  webhookRouter,
};
