// ********* EVAL/ROUTER.JS *********
'use strict';

// HTTP route handler for the synthetic evaluation endpoint.
//
// Registered at /webex/collab/eval/ (prefix match) when WEBEX_EVAL_ROUTES_ENABLED=true.
// Accepts POST /webex/collab/eval/run with a scenario JSON body, runs the full
// plugin pipeline against synthetic hydrated Webex messages, and returns a result
// bundle containing items, conversations, threads, routing decisions, recall
// responses, timings, and a run log.
//
// Auth: requires x-webex-eval-secret header matching WEBEX_EVAL_SECRET env var.
// Both env vars must be set; if either is absent the route returns 403.

const { runScenario } = require('../scripts/eval/run-scenario');

const MAX_BODY_BYTES = 10 * 1024 * 1024; // 10MB — scenarios can be large

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sendJson(res, statusCode, body) {
  res.statusCode = statusCode;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(body, null, 2) + '\n');
}

function getPathname(req) {
  return new URL(req.url ?? '/', 'http://x').pathname;
}

async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) return null;
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

function isSecretValid(req) {
  const required = process.env.WEBEX_EVAL_SECRET;
  if (!required) return false;
  const provided = req.headers['x-webex-eval-secret'];
  return typeof provided === 'string' && provided === required;
}

function makeLog() {
  return {
    info: (msg, meta) => console.log('[eval]', msg, meta != null ? meta : ''),
    warn: (msg, meta) => console.warn('[eval:warn]', msg, meta != null ? meta : ''),
    error: (msg, meta) => console.error('[eval:error]', msg, meta != null ? meta : ''),
  };
}

// ---------------------------------------------------------------------------
// Route handler
//
// Returns false if the path is not /webex/collab/eval/run (OpenClaw skips to
// the next registered handler).  Returns true once the request is handled.
// ---------------------------------------------------------------------------

async function evalRouter(req, res) {
  const pathname = getPathname(req);
  if (pathname !== '/webex/collab/eval/run') return false;

  if (req.method !== 'POST') {
    res.statusCode = 405;
    res.setHeader('Allow', 'POST');
    res.end('Method Not Allowed');
    return true;
  }

  if (!isSecretValid(req)) {
    sendJson(res, 403, { ok: false, error: 'Forbidden' });
    return true;
  }

  let rawBody;
  try {
    rawBody = await readBody(req);
  } catch {
    sendJson(res, 400, { ok: false, error: 'Failed to read request body' });
    return true;
  }

  if (!rawBody) {
    sendJson(res, 413, { ok: false, error: 'Payload Too Large' });
    return true;
  }

  let body;
  try {
    body = JSON.parse(rawBody.toString('utf-8'));
  } catch {
    sendJson(res, 400, { ok: false, error: 'Invalid JSON' });
    return true;
  }

  const { scenario, options } = body;

  if (!scenario?.id) {
    sendJson(res, 400, { ok: false, error: 'scenario.id is required' });
    return true;
  }
  if (!scenario.spaceId) {
    sendJson(res, 400, { ok: false, error: 'scenario.spaceId is required' });
    return true;
  }
  if (!Array.isArray(scenario.participants)) {
    sendJson(res, 400, { ok: false, error: 'scenario.participants must be an array' });
    return true;
  }
  if (!Array.isArray(scenario.messages)) {
    sendJson(res, 400, { ok: false, error: 'scenario.messages must be an array' });
    return true;
  }

  console.log(`[eval] received run request for scenario "${scenario.id}" (${scenario.messages.length} messages)`);

  let result;
  try {
    result = await runScenario({ scenario, options, log: makeLog() });
  } catch (err) {
    console.error('[eval] runScenario failed:', err?.message ?? err);
    sendJson(res, 500, { ok: false, error: err?.message ?? String(err) });
    return true;
  }

  sendJson(res, 200, { ok: true, result });
  return true;
}

module.exports = { evalRouter };
