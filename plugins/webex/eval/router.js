// ********* EVAL/ROUTER.JS *********
'use strict';

// Async job eval route.  Registered at /webex/collab/eval/ (prefix match)
// when WEBEX_EVAL_ROUTES_ENABLED=true.
//
// Endpoints:
//   POST /webex/collab/eval/run              — retired, see below
//   GET  /webex/collab/eval/runs/:runId      — poll run status
//   GET  /webex/collab/eval/runs/:runId/result — fetch completed result
//
// Auth: all endpoints require x-webex-eval-secret matching WEBEX_EVAL_SECRET.
//
// Job state is held in-memory and lost on restart.
//
// RUN IS RETIRED (phase 6 deletion pass): the old scripts/eval/run-scenario.js and
// the pre-v3 batch/processing pipeline it drove (staging-handler,
// processing-handler, items/conversations stores, etc.) have been deleted —
// entirely superseded by run-message-flow.js, and non-functional against it
// regardless (round-grouping and staging assumptions baked into the old
// runner don't hold under deterministic dispatch, per its own now-removed
// comments). POST /run returns 501 rather than trying to call something
// that no longer exists. Status/result polling stay wired — harmless no-ops
// until a new scenario runner is built against the v3 pipeline and starts
// populating `runs` again. The client script (eval/post-scenario.js) is
// untouched — it's a plain HTTP client with no dependency on any of this.

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

  sendJson(res, 501, {
    ok: false,
    error:
      'Scenario running is retired pending a rewrite against the v3 pipeline (run-message-flow.js). ' +
      'The old runner and the pipeline it drove were removed in the phase-6 deletion pass.',
  });
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
