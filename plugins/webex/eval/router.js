// ********* EVAL/ROUTER.JS *********
'use strict';

// Async job eval route.  Registered at /webex/collab/eval/ (prefix match)
// when WEBEX_EVAL_ROUTES_ENABLED=true.
//
// Endpoints:
//   POST /webex/collab/eval/run              — start a background run, return runId
//   GET  /webex/collab/eval/runs/:runId      — poll run status
//   GET  /webex/collab/eval/runs/:runId/result — fetch completed result
//
// Auth: all endpoints require x-webex-eval-secret matching WEBEX_EVAL_SECRET.
//
// Job state is held in-memory and lost on restart.

const { randomUUID } = require('node:crypto');
const { runScenario } = require('../scripts/eval/run-scenario');

const MAX_BODY_BYTES = 10 * 1024 * 1024;

// In-memory job store: runId → run record
const runs = new Map();

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

const RUNS_STATUS_RE = /^\/webex\/collab\/eval\/runs\/([^/]+)$/;
const RUNS_RESULT_RE = /^\/webex\/collab\/eval\/runs\/([^/]+)\/result$/;

// ---------------------------------------------------------------------------
// POST /webex/collab/eval/run
// ---------------------------------------------------------------------------

async function handleRunPost(req, res) {
  if (!isSecretValid(req)) {
    sendJson(res, 403, { ok: false, error: 'Forbidden' });
    return;
  }

  let rawBody;
  try {
    rawBody = await readBody(req);
  } catch {
    sendJson(res, 400, { ok: false, error: 'Failed to read request body' });
    return;
  }

  if (!rawBody) {
    sendJson(res, 413, { ok: false, error: 'Payload Too Large' });
    return;
  }

  let body;
  try {
    body = JSON.parse(rawBody.toString('utf-8'));
  } catch {
    sendJson(res, 400, { ok: false, error: 'Invalid JSON' });
    return;
  }

  const { scenario, options } = body;

  if (!scenario?.id) {
    sendJson(res, 400, { ok: false, error: 'scenario.id is required' });
    return;
  }
  if (!scenario.spaceId) {
    sendJson(res, 400, { ok: false, error: 'scenario.spaceId is required' });
    return;
  }
  if (!Array.isArray(scenario.participants)) {
    sendJson(res, 400, { ok: false, error: 'scenario.participants must be an array' });
    return;
  }
  if (!Array.isArray(scenario.messages)) {
    sendJson(res, 400, { ok: false, error: 'scenario.messages must be an array' });
    return;
  }

  const runId = randomUUID();
  const startedAt = new Date().toISOString();

  const run = {
    runId,
    scenarioId: scenario.id,
    status: 'running',
    startedAt,
    completedAt: null,
    error: null,
    result: null,
  };
  runs.set(runId, run);

  console.log(
    `[eval:${runId}] run started — scenario: ${scenario.id}, messages: ${scenario.messages.length}`
  );

  const log = {
    info: (msg, meta) => console.log(`[eval:${runId}]`, msg, meta != null ? meta : ''),
    warn: (msg, meta) => console.warn(`[eval:${runId}:warn]`, msg, meta != null ? meta : ''),
    error: (msg, meta) => console.error(`[eval:${runId}:error]`, msg, meta != null ? meta : ''),
  };

  runScenario({ scenario, options, log })
    .then((result) => {
      run.status = 'complete';
      run.completedAt = new Date().toISOString();
      run.result = result;
      const durationMs = new Date(run.completedAt) - new Date(startedAt);
      console.log(
        `[eval:${runId}] run complete — duration: ${durationMs}ms,` +
        ` items: ${result.items.length}, conversations: ${result.conversations.length}`
      );
    })
    .catch((err) => {
      run.status = 'failed';
      run.completedAt = new Date().toISOString();
      run.error = { message: err?.message ?? String(err), stack: err?.stack ?? null };
      console.error(`[eval:${runId}] run failed — ${err?.message ?? err}`);
      if (err?.stack) console.error(err.stack);
    });

  sendJson(res, 202, { ok: true, runId, scenarioId: scenario.id, status: 'running' });
}

// ---------------------------------------------------------------------------
// GET /webex/collab/eval/runs/:runId
// ---------------------------------------------------------------------------

function handleRunStatus(req, res, runId) {
  if (!isSecretValid(req)) {
    sendJson(res, 403, { ok: false, error: 'Forbidden' });
    return;
  }

  const run = runs.get(runId);
  if (!run) {
    sendJson(res, 404, { ok: false, error: 'Run not found' });
    return;
  }

  sendJson(res, 200, {
    ok: true,
    runId: run.runId,
    scenarioId: run.scenarioId,
    status: run.status,
    startedAt: run.startedAt,
    completedAt: run.completedAt,
    ...(run.error != null ? { error: run.error } : {}),
  });
}

// ---------------------------------------------------------------------------
// GET /webex/collab/eval/runs/:runId/result
// ---------------------------------------------------------------------------

function handleRunResult(req, res, runId) {
  if (!isSecretValid(req)) {
    sendJson(res, 403, { ok: false, error: 'Forbidden' });
    return;
  }

  const run = runs.get(runId);
  if (!run) {
    sendJson(res, 404, { ok: false, error: 'Run not found' });
    return;
  }

  if (run.status === 'running') {
    sendJson(res, 202, { ok: false, status: 'running', runId, scenarioId: run.scenarioId });
    return;
  }

  if (run.status === 'failed') {
    sendJson(res, 200, {
      ok: false,
      status: 'failed',
      runId,
      scenarioId: run.scenarioId,
      error: run.error,
    });
    return;
  }

  sendJson(res, 200, {
    ok: true,
    status: 'complete',
    runId,
    scenarioId: run.scenarioId,
    result: run.result,
  });
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

async function evalRouter(req, res) {
  const pathname = getPathname(req);

  if (pathname === '/webex/collab/eval/run') {
    if (req.method !== 'POST') {
      res.statusCode = 405;
      res.setHeader('Allow', 'POST');
      res.end('Method Not Allowed');
      return true;
    }
    await handleRunPost(req, res);
    return true;
  }

  const statusMatch = RUNS_STATUS_RE.exec(pathname);
  if (statusMatch) {
    if (req.method !== 'GET') {
      res.statusCode = 405;
      res.setHeader('Allow', 'GET');
      res.end('Method Not Allowed');
      return true;
    }
    handleRunStatus(req, res, statusMatch[1]);
    return true;
  }

  const resultMatch = RUNS_RESULT_RE.exec(pathname);
  if (resultMatch) {
    if (req.method !== 'GET') {
      res.statusCode = 405;
      res.setHeader('Allow', 'GET');
      res.end('Method Not Allowed');
      return true;
    }
    handleRunResult(req, res, resultMatch[1]);
    return true;
  }

  return false;
}

module.exports = { evalRouter };
