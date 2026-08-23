#!/usr/bin/env node
// ********* EVAL/POST-SCENARIO.JS *********
'use strict';

// Local client: reads a scenario JSON file, POSTs it to the eval route on a
// running OpenClaw instance, polls until complete, and saves the result bundle.
//
// Usage:
//   WEBEX_EVAL_SECRET=<secret> \
//   node plugins/webex/eval/post-scenario.js \
//     plugins/webex/eval/scenarios/scenario-01-brainstorming.json \
//     https://<host>/webex/collab/eval
//
// The second argument is the eval base URL (no trailing /run).
// Endpoints used:
//   POST <base>/run
//   GET  <base>/runs/:runId/result   (polled until complete or failed)
//
// Output files written to:
//   plugins/webex/eval/outputs/<scenario-id>/
//     response.json          full result bundle
//     items.json
//     conversations.json
//     threads.json
//     routing-decisions.json
//     recall-responses.json
//     timings.json
//     run-log.json

const fs = require('node:fs/promises');
const path = require('node:path');
const https = require('node:https');
const http = require('node:http');

const PLUGIN_ROOT = path.join(__dirname, '..');
const POLL_INTERVAL_MS = 5_000;
const POLL_TIMEOUT_MS = 20 * 60 * 1000; // 20 minutes

// ---------------------------------------------------------------------------
// Args
// ---------------------------------------------------------------------------

const [, , scenarioArg, baseUrlArg] = process.argv;

if (!scenarioArg || !baseUrlArg) {
  console.error(
    'Usage: node post-scenario.js <scenario.json> <eval-base-url>\n' +
    'Env:   WEBEX_EVAL_SECRET\n' +
    'Example base URL: https://<host>/webex/collab/eval'
  );
  process.exit(1);
}

const secret = process.env.WEBEX_EVAL_SECRET;
if (!secret) {
  console.error('Error: WEBEX_EVAL_SECRET env var is required');
  process.exit(1);
}

const baseUrl = baseUrlArg.replace(/\/$/, '');

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

function request(url, method, headers, body) {
  const parsed = new URL(url);
  const lib = parsed.protocol === 'https:' ? https : http;
  const payload = body != null ? Buffer.from(JSON.stringify(body), 'utf-8') : null;

  return new Promise((resolve, reject) => {
    const req = lib.request(
      url,
      {
        method,
        headers: {
          ...(payload != null
            ? { 'Content-Type': 'application/json', 'Content-Length': payload.length }
            : {}),
          ...headers,
        },
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const raw = Buffer.concat(chunks).toString('utf-8');
          try {
            resolve({ status: res.statusCode, body: JSON.parse(raw) });
          } catch {
            reject(
              new Error(`Non-JSON response (${res.statusCode}): ${raw.slice(0, 300)}`)
            );
          }
        });
        res.on('error', reject);
      }
    );
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

const authHeaders = { 'x-webex-eval-secret': secret };

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// Poll until the result endpoint returns 200 (complete or failed) or times out
// ---------------------------------------------------------------------------

async function pollResult(runId) {
  const resultUrl = `${baseUrl}/runs/${runId}/result`;
  const deadline = Date.now() + POLL_TIMEOUT_MS;
  let attempts = 0;

  while (Date.now() < deadline) {
    attempts += 1;
    await sleep(POLL_INTERVAL_MS);

    let res;
    try {
      res = await request(resultUrl, 'GET', authHeaders, null);
    } catch (err) {
      console.warn(`[post-scenario] poll attempt ${attempts} failed: ${err.message}`);
      continue;
    }

    if (res.status === 202) {
      process.stdout.write('.');
      continue;
    }

    // 200 means done (ok:true = complete, ok:false = failed)
    if (res.status === 200) {
      console.log(''); // end the progress dots line
      return res.body;
    }

    // Unexpected status
    console.log('');
    throw new Error(
      `Unexpected status ${res.status} from result endpoint: ${JSON.stringify(res.body)}`
    );
  }

  console.log('');
  throw new Error(`Poll timed out after ${POLL_TIMEOUT_MS / 1000}s waiting for run ${runId}`);
}

// ---------------------------------------------------------------------------
// Save result bundle locally
// ---------------------------------------------------------------------------

async function saveOutputs(scenario, result) {
  const outputDir = path.join(PLUGIN_ROOT, 'eval', 'outputs', scenario.id);
  await fs.rm(outputDir, { recursive: true, force: true });
  await fs.mkdir(outputDir, { recursive: true });

  const writeJson = (name, data) =>
    fs.writeFile(path.join(outputDir, name), JSON.stringify(data, null, 2) + '\n', 'utf-8');

  await writeJson('response.json', result);
  if (result.items?.length) await writeJson('items.json', result.items);
  if (result.conversations?.length) await writeJson('conversations.json', result.conversations);
  if (result.threads?.length) await writeJson('threads.json', result.threads);
  if (result.routingDecisions?.length) await writeJson('routing-decisions.json', result.routingDecisions);
  if (result.recallResponses?.length) await writeJson('recall-responses.json', result.recallResponses);
  await writeJson('timings.json', result.timings);
  await writeJson('run-log.json', result.runLog);

  return outputDir;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

(async () => {
  const scenarioRaw = await fs.readFile(path.resolve(scenarioArg), 'utf-8');
  const scenario = JSON.parse(scenarioRaw);

  console.log(
    `[post-scenario] scenario: ${scenario.id} (${scenario.messages?.length ?? 0} messages)`
  );
  console.log(`[post-scenario] posting to: ${baseUrl}/run`);

  // Start the run
  let startRes;
  try {
    startRes = await request(
      `${baseUrl}/run`,
      'POST',
      authHeaders,
      { scenario, options: { clearPrevious: true } }
    );
  } catch (err) {
    console.error('[post-scenario] POST failed:', err.message);
    process.exit(1);
  }

  if (startRes.status !== 202 || !startRes.body?.ok) {
    console.error(
      `[post-scenario] unexpected POST response (${startRes.status}):`,
      JSON.stringify(startRes.body, null, 2)
    );
    process.exit(1);
  }

  const { runId } = startRes.body;
  console.log(`[post-scenario] run started: ${runId}`);
  console.log('[post-scenario] polling for result (. = still running)');
  process.stdout.write('[post-scenario] ');

  const startMs = Date.now();
  let pollResponse;
  try {
    pollResponse = await pollResult(runId);
  } catch (err) {
    console.error('[post-scenario] polling error:', err.message);
    process.exit(1);
  }

  const elapsedMs = Date.now() - startMs;
  console.log(`[post-scenario] elapsed: ${(elapsedMs / 1000).toFixed(1)}s`);

  if (!pollResponse.ok || pollResponse.status === 'failed') {
    console.error('[post-scenario] run failed:');
    console.error(JSON.stringify(pollResponse.error ?? pollResponse, null, 2));
    process.exit(1);
  }

  const result = pollResponse.result;
  const outputDir = await saveOutputs(scenario, result);

  console.log(`[post-scenario] outputs saved to: ${outputDir}`);
  console.log(`[post-scenario] rounds:   ${result.timings?.rounds?.length ?? 0}`);
  console.log(`[post-scenario] items:    ${result.items?.length ?? 0}`);
  console.log(`[post-scenario] convs:    ${result.conversations?.length ?? 0}`);
  console.log(`[post-scenario] recalls:  ${result.recallResponses?.length ?? 0}`);
})().catch((err) => {
  console.error('[post-scenario] fatal:', err.message);
  process.exit(1);
});
