#!/usr/bin/env node
// ********* SCRIPTS/EVAL/POST-SCENARIO.JS *********
'use strict';

// Local client: reads a scenario JSON file, POSTs it to the eval route on a
// running OpenClaw instance, and saves the returned result bundle locally.
//
// Usage:
//   WEBEX_EVAL_SECRET=<secret> \
//   node plugins/webex/scripts/eval/post-scenario.js \
//     plugins/webex/evaluation/scenarios/scenario-01-brainstorming.json \
//     https://<host>/webex/collab/eval/run
//
// Output files written to:
//   plugins/webex/evaluation/outputs/<scenario-id>/
//     response.json          — full result bundle
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

const PLUGIN_ROOT = path.join(__dirname, '..', '..');

// ---------------------------------------------------------------------------
// Args
// ---------------------------------------------------------------------------

const [, , scenarioArg, urlArg] = process.argv;

if (!scenarioArg || !urlArg) {
  console.error(
    'Usage: node post-scenario.js <scenario.json> <eval-route-url>\n' +
    'Env:   WEBEX_EVAL_SECRET'
  );
  process.exit(1);
}

const secret = process.env.WEBEX_EVAL_SECRET;
if (!secret) {
  console.error('Error: WEBEX_EVAL_SECRET env var is required');
  process.exit(1);
}

// ---------------------------------------------------------------------------
// HTTP POST helper
// ---------------------------------------------------------------------------

function postJson(url, body, headers) {
  const payload = Buffer.from(JSON.stringify(body), 'utf-8');
  const parsed = new URL(url);
  const lib = parsed.protocol === 'https:' ? https : http;

  return new Promise((resolve, reject) => {
    const req = lib.request(
      url,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': payload.length,
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
            reject(new Error(`Non-JSON response (${res.statusCode}): ${raw.slice(0, 200)}`));
          }
        });
        res.on('error', reject);
      }
    );
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

(async () => {
  const scenarioRaw = await fs.readFile(path.resolve(scenarioArg), 'utf-8');
  const scenario = JSON.parse(scenarioRaw);

  console.log(`[post-scenario] scenario: ${scenario.id} (${scenario.messages?.length ?? 0} messages)`);
  console.log(`[post-scenario] posting to: ${urlArg}`);

  const startMs = Date.now();
  let response;
  try {
    response = await postJson(
      urlArg,
      { scenario, options: { clearPrevious: true } },
      { 'x-webex-eval-secret': secret }
    );
  } catch (err) {
    console.error('[post-scenario] request failed:', err.message);
    process.exit(1);
  }

  const elapsed = Date.now() - startMs;
  console.log(`[post-scenario] response: ${response.status} (${elapsed}ms)`);

  if (response.status !== 200 || !response.body?.ok) {
    console.error('[post-scenario] server error:', JSON.stringify(response.body, null, 2));
    process.exit(1);
  }

  const result = response.body.result;

  const outputDir = path.join(PLUGIN_ROOT, 'evaluation', 'outputs', scenario.id);
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

  console.log(`[post-scenario] outputs saved to: ${outputDir}`);
  console.log(`[post-scenario] rounds:   ${result.timings?.rounds?.length ?? 0}`);
  console.log(`[post-scenario] items:    ${result.items?.length ?? 0}`);
  console.log(`[post-scenario] convs:    ${result.conversations?.length ?? 0}`);
  console.log(`[post-scenario] recalls:  ${result.recallResponses?.length ?? 0}`);
})().catch((err) => {
  console.error('[post-scenario] fatal:', err.message);
  process.exit(1);
});
