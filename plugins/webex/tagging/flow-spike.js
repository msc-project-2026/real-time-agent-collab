// ********* TAGGING/FLOW-SPIKE.JS *********
'use strict';

// v3 §7b implementation guardrail: before phase 5 depends on Task Flow for
// real, this proves the primitives (createManaged/runTask/resume/finish)
// work from this plugin's actual request path — the Webex webhook route,
// registered with `auth: 'plugin'`. That matters because phase 3 already
// found that `pluginRuntime.subagent.run()` is dead from exactly this
// context (zero operator scope for gateway-method-RPC calls made from an
// `auth: 'plugin'` route, unconditionally — see tagging/dispatch.js).
// Task Flow's mutation API is a different code path and may not have the
// same problem, but that's exactly what this spike exists to confirm
// empirically rather than assume. Diagnostic only: fire-and-forget,
// flag-gated, never throws, never affects dispatch.

const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const { safeSegment } = require('../storage/paths');
const { getRoutingAgentId } = require('../runtime');

const LOG_PREFIX = '[collab-agent:tagging-flow-spike]';
const GATE_TIMEOUT_MS = 15_000;

async function runFlowSpike({ pluginRuntime, spaceId, threadKey, message, log }) {
  if (!pluginRuntime?.tasks?.flow?.bindSession) {
    log?.warn?.(`${LOG_PREFIX} unavailable — runtime does not expose tasks.flow`);
    return;
  }

  const agentId = getRoutingAgentId();
  const sessionKey = `agent:${agentId}:webex:${spaceId}:flow-spike:${safeSegment(
    threadKey
  )}`;

  let bound;
  try {
    bound = pluginRuntime.tasks.flow.bindSession({ sessionKey });
  } catch (err) {
    log?.error?.(
      `${LOG_PREFIX} bindSession threw ${JSON.stringify({
        sessionKey,
        error: err?.message ?? String(err),
        stack: err?.stack ?? null,
      })}`
    );
    return;
  }

  let flow;
  try {
    flow = bound.createManaged({
      controllerId: 'webex-flow-spike',
      goal: 'phase 4 Task Flow API spike',
      currentStep: 'gate',
      stateJson: { spaceId, threadKey, messageId: message?.id ?? null },
    });
    log?.info?.(
      `${LOG_PREFIX} createManaged ${JSON.stringify({
        sessionKey,
        flowId: flow?.flowId,
        revision: flow?.revision,
        status: flow?.status,
      })}`
    );
  } catch (err) {
    log?.error?.(
      `${LOG_PREFIX} createManaged threw ${JSON.stringify({
        sessionKey,
        error: err?.message ?? String(err),
        stack: err?.stack ?? null,
      })}`
    );
    return;
  }

  const flowId = flow?.flowId;
  if (!flowId) {
    log?.warn?.(`${LOG_PREFIX} createManaged returned no flowId — aborting spike`);
    return;
  }

  const runId = `flow-spike-${Date.now()}`;
  let gateResult;
  let tempDir;
  try {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'webex-flow-spike-'));
    const sessionFile = path.join(tempDir, 'session.jsonl');

    const cfg = pluginRuntime.config.current();
    const workspaceDir = pluginRuntime.agent.resolveAgentWorkspaceDir(cfg, agentId);
    const agentDir = pluginRuntime.agent.resolveAgentDir(cfg, agentId);

    gateResult = await pluginRuntime.agent.runEmbeddedAgent({
      sessionId: `${runId}-${Math.random().toString(36).slice(2, 10)}`,
      sessionKey,
      agentId,
      sessionFile,
      workspaceDir,
      agentDir,
      config: cfg,
      prompt:
        'This is a diagnostic Task Flow API spike (v3 phase 4). Reply with the single word "done" and take no other action.',
      timeoutMs: GATE_TIMEOUT_MS,
      runId,
      disableMessageTool: true,
      allowEmptyAssistantReplyAsSilent: true,
    });
    log?.info?.(
      `${LOG_PREFIX} gate spawn completed ${JSON.stringify({
        sessionKey,
        runId,
        stopReason: gateResult?.meta?.stopReason ?? null,
      })}`
    );
  } catch (err) {
    log?.error?.(
      `${LOG_PREFIX} gate spawn threw ${JSON.stringify({
        sessionKey,
        runId,
        error: err?.message ?? String(err),
        stack: err?.stack ?? null,
      })}`
    );
  } finally {
    if (tempDir) {
      await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
    }
  }

  let afterRunTask;
  try {
    // `runTask` has no "embedded" runtime option (only subagent/acp/cli/cron)
    // — "subagent" is the closest available label even though the actual
    // spawn above went through runEmbeddedAgent, not subagent.run. Noted as
    // a finding, not worked around.
    afterRunTask = bound.runTask({
      flowId,
      runtime: 'subagent',
      childSessionKey: sessionKey,
      runId,
      task: 'flow-spike-gate',
    });
    log?.info?.(
      `${LOG_PREFIX} runTask ${JSON.stringify({
        flowId,
        runId,
        created: afterRunTask?.created,
        taskId: afterRunTask?.task?.taskId ?? null,
        reason: afterRunTask?.reason ?? null,
      })}`
    );
  } catch (err) {
    log?.error?.(
      `${LOG_PREFIX} runTask threw ${JSON.stringify({
        flowId,
        runId,
        error: err?.message ?? String(err),
        stack: err?.stack ?? null,
      })}`
    );
  }

  let afterResume;
  try {
    afterResume = bound.resume({
      flowId,
      expectedRevision: flow.revision,
      currentStep: 'done',
      stateJson: { completedAt: Date.now() },
    });
    log?.info?.(
      `${LOG_PREFIX} resume ${JSON.stringify({
        flowId,
        applied: afterResume?.applied,
        revision: afterResume?.flow?.revision ?? null,
        code: afterResume?.code ?? null,
      })}`
    );
  } catch (err) {
    log?.error?.(
      `${LOG_PREFIX} resume threw ${JSON.stringify({
        flowId,
        error: err?.message ?? String(err),
        stack: err?.stack ?? null,
      })}`
    );
  }

  const finishRevision = afterResume?.flow?.revision ?? flow.revision;
  try {
    const finished = bound.finish({ flowId, expectedRevision: finishRevision });
    log?.info?.(
      `${LOG_PREFIX} finish ${JSON.stringify({
        flowId,
        applied: finished?.applied,
        status: finished?.flow?.status ?? null,
        code: finished?.code ?? null,
      })}`
    );
  } catch (err) {
    log?.error?.(
      `${LOG_PREFIX} finish threw ${JSON.stringify({
        flowId,
        error: err?.message ?? String(err),
        stack: err?.stack ?? null,
      })}`
    );
  }
}

module.exports = {
  runFlowSpike,
};
