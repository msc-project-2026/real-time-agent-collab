// ********* EVAL/GATEWAY-METHOD.JS *********
'use strict';

// Phase 8 — the in-gateway trigger for the eval scenario runner.
//
// The runner (eval/run-scenario.js) needs a live plugin runtime (real
// runEmbeddedAgent + tasks.flow), which only exists inside the running
// gateway process — a plugin CLI subcommand loads without a runtime in this
// gateway version, and a standalone script never calls register(). So the
// runner is exposed as a gateway RPC method and driven from the deployment
// with:
//
//   node openclaw.mjs gateway call webex.eval.run \
//     --params '{"scenarioId":"eval-s01-release-readiness"}' \
//     --timeout 1800000 --json
//
// The method blocks on the run and returns the full bundle. run-scenario.js
// also always writes the bundle to disk under eval/outputs/<id>/<variant>/
// <evalRunId>/, so a client-side --timeout expiry just means retrieving
// <outputDir>/bundle.json over ssh rather than losing the run.
//
// Scope: operator.write — the same bar workboard's mutating methods use.
// `openclaw gateway call` from inside the container satisfies it via
// OPENCLAW_GATEWAY_TOKEN with no extra flags.

const fs = require('node:fs/promises');
const path = require('node:path');

const { runScenario } = require('./run-scenario');

const SCENARIOS_DIR = path.join(__dirname, 'scenarios');
const METHOD_NAME = 'webex.eval.run';

async function readScenarioById(scenarioId) {
  const safe = String(scenarioId).replace(/[^a-zA-Z0-9._-]/g, '_');
  const file = path.join(SCENARIOS_DIR, `${safe}.json`);
  return JSON.parse(await fs.readFile(file, 'utf8'));
}

async function resolveScenario(params) {
  if (params?.scenario && typeof params.scenario === 'object') {
    return params.scenario;
  }
  if (typeof params?.scenarioId === 'string' && params.scenarioId) {
    return readScenarioById(params.scenarioId);
  }
  if (typeof params?.scenarioPath === 'string' && params.scenarioPath) {
    return JSON.parse(await fs.readFile(params.scenarioPath, 'utf8'));
  }
  return null;
}

async function handleEvalRun({ params, respond }, logger) {
  let scenario;
  try {
    scenario = await resolveScenario(params);
  } catch (err) {
    respond(false, undefined, {
      code: 'webex_eval_scenario_read_failed',
      message: err?.message ?? String(err),
    });
    return;
  }

  if (!scenario?.id || !Array.isArray(scenario.messages)) {
    respond(false, undefined, {
      code: 'webex_eval_bad_scenario',
      message:
        'params must resolve to a scenario object with an `id` and a `messages` array ' +
        '(pass scenarioId, scenarioPath, or an inline scenario)',
    });
    return;
  }

  const variant = typeof params?.variant === 'string' ? params.variant : 'baseline';
  const overrides =
    params?.overrides && typeof params.overrides === 'object' ? params.overrides : {};

  const evalLog = {
    info: (msg, meta) => logger?.info?.(`[webex-eval] ${msg} ${meta ? JSON.stringify(meta) : ''}`),
    warn: (msg, meta) => logger?.warn?.(`[webex-eval] ${msg} ${meta ? JSON.stringify(meta) : ''}`),
    error: (msg, meta) => logger?.error?.(`[webex-eval] ${msg} ${meta ? JSON.stringify(meta) : ''}`),
  };

  try {
    const bundle = await runScenario({ scenario, variant, overrides, log: evalLog });
    respond(true, bundle);
  } catch (err) {
    respond(false, undefined, {
      code: 'webex_eval_run_failed',
      message: err?.message ?? String(err),
      stack: err?.stack ?? null,
    });
  }
}

function registerEvalGatewayMethod(api) {
  // api.logger is passed explicitly rather than read off the handler's own
  // opts: the gateway-method handler contract is not documented to provide a
  // logger, and the first live run produced no gateway-side output at all,
  // so every progress line was stranded in the bundle's in-memory runLog and
  // lost when bundle assembly threw.
  api.registerGatewayMethod(
    METHOD_NAME,
    (opts) => handleEvalRun(opts, api.logger),
    { scope: 'operator.write' }
  );
}

module.exports = {
  registerEvalGatewayMethod,
  METHOD_NAME,
  resolveScenario,
};
