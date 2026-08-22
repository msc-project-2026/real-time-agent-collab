// ********* FLOW/RUN-MESSAGE-FLOW.JS *********
'use strict';

// v3 phase 5 orchestrator — one managed Task Flow per message (§7a), created
// when the message reaches the tagging gate (the gate is the flow's first
// step, not a separate mechanism in front of it). Flow-level tracking only
// (createManaged/resume/finish/fail) — no runTask; see v3 migration memory
// for why task-level tracking is structurally unusable for the
// runEmbeddedAgent-driven spawns this plugin uses. Step-level detail instead
// goes to the job log (flow/job-log.js).
//
// Replaces the old sequence in inbound/message.js (dispatchTaggingGate ->
// decideDispatch -> handleStagePendingBatchRequest) and the phase-4
// tagging/flow-spike.js probe, now superseded.

const { dispatchTaggingGate } = require('../tagging/dispatch');
const { decideDispatch } = require('../tagging/decide');
const { handleConfigRequest } = require('../config/handle-request');
const {
  getPendingSlice,
  markThreadMessagesProcessed,
} = require('../context/threads-store');
const { runRespondStep } = require('../processing/respond');
const { appendJobLogEntry } = require('./job-log');
const { safeSegment } = require('../storage/paths');
const { getPluginRuntime, getRoutingAgentId } = require('../runtime');

const LOG_PREFIX = '[collab-agent:flow-orchestration]';

function safeMutate(fnName, bound, log, params) {
  if (!bound) return null;
  try {
    return bound[fnName](params);
  } catch (err) {
    log?.error?.(
      `${LOG_PREFIX} ${fnName} threw ${JSON.stringify({
        flowId: params.flowId,
        error: err?.message ?? String(err),
        stack: err?.stack ?? null,
      })}`
    );
    return null;
  }
}

async function runMessageFlow({
  spaceId,
  threadKey,
  message,
  botId,
  account,
  log,
  sendFn,
}) {
  if (!spaceId) throw new Error('spaceId is required');
  if (!threadKey) throw new Error('threadKey is required');

  const pluginRuntime = getPluginRuntime();
  const agentId = getRoutingAgentId();
  const sessionKey = `agent:${agentId}:webex:${spaceId}:${safeSegment(threadKey)}`;

  let bound = null;
  let flow = null;

  if (pluginRuntime?.tasks?.flow?.bindSession) {
    try {
      bound = pluginRuntime.tasks.flow.bindSession({ sessionKey });
      flow = bound.createManaged({
        controllerId: 'webex-message-flow',
        goal: 'process inbound message',
        currentStep: 'gate',
        stateJson: { spaceId, threadKey, messageId: message?.id ?? null },
      });
    } catch (err) {
      log?.error?.(
        `${LOG_PREFIX} createManaged threw ${JSON.stringify({
          spaceId,
          threadKey,
          error: err?.message ?? String(err),
        })}`
      );
    }
  }

  const flowId = flow?.flowId ?? null;
  let revision = flow?.revision ?? null;

  // -- gate step (v3 §4) — unchanged call into tagging/dispatch.js.
  const gateStartedAt = new Date().toISOString();
  const tagResult = await dispatchTaggingGate({
    pluginRuntime,
    spaceId,
    threadKey,
    message,
    log,
  });
  const gateEndedAt = new Date().toISOString();

  if (flowId) {
    await appendJobLogEntry({
      spaceId,
      flowId,
      step: 'gate',
      startedAt: gateStartedAt,
      endedAt: gateEndedAt,
      outcome: tagResult ? 'success' : 'unavailable',
      inputSummary: { messageId: message?.id ?? null },
    }).catch(() => {});
  }

  const botIsMentioned =
    Array.isArray(message.mentionedPeople) && message.mentionedPeople.includes(botId);

  const decision = decideDispatch({ tagResult, botIsMentioned });

  // Anchor line for understanding this message's outcome from logs alone —
  // same shape as before phase 5, just moved here from inbound/message.js.
  log?.info?.(
    `${LOG_PREFIX} dispatch decision ${JSON.stringify({
      spaceId,
      threadKey,
      messageId: message.id,
      flowId,
      gateRan: Boolean(tagResult),
      gateIsMentioned: tagResult?.messageTags?.isMentioned ?? null,
      gateConfigRequest: tagResult?.messageTags?.configRequest ?? null,
      gateReady: tagResult?.pendingThreadWindowDecision?.ready ?? null,
      botIsMentioned,
      finalIsMentioned: decision.finalIsMentioned,
      configRequest: decision.configRequest,
      shouldProcess: decision.shouldProcess,
    })}`
  );

  // configRequest and shouldProcess are independent (both can fire for the
  // same message) — preserve that, matches pre-phase-5 behavior.
  if (decision.configRequest) {
    await handleConfigRequest({ spaceId, account, log, sendFn });
  }

  if (!decision.shouldProcess) {
    const finished = safeMutate('finish', bound, log, {
      flowId,
      expectedRevision: revision,
      stateJson: { outcome: 'no-op' },
    });
    revision = finished?.flow?.revision ?? revision;
    return;
  }

  const pendingSlice = await getPendingSlice({ spaceId, threadKey });
  const messageIds = pendingSlice.map((entry) => entry.id);

  if (messageIds.length > 0) {
    await markThreadMessagesProcessed({ spaceId, threadKey, messageIds });
  }

  const resumed = safeMutate('resume', bound, log, {
    flowId,
    expectedRevision: revision,
    currentStep: 'respond',
    stateJson: {
      directive: {
        addressed: decision.finalIsMentioned,
        ready: decision.ready,
        reason: decision.reason,
      },
    },
  });
  revision = resumed?.flow?.revision ?? revision;

  const respondStartedAt = new Date().toISOString();
  let respondResult = null;
  let respondError = null;

  try {
    respondResult = await runRespondStep({
      pluginRuntime,
      spaceId,
      threadKey,
      message,
      decision,
      log,
    });
  } catch (err) {
    respondError = err;
  }

  const respondEndedAt = new Date().toISOString();

  if (flowId) {
    await appendJobLogEntry({
      spaceId,
      flowId,
      step: 'respond',
      runId: respondResult?.runId ?? null,
      sessionKey: respondResult?.sessionKey ?? null,
      startedAt: respondStartedAt,
      endedAt: respondEndedAt,
      outcome: respondError ? 'error' : 'success',
      error: respondError ? (respondError.message ?? String(respondError)) : null,
      toolCalls: respondResult?.toolCalls ?? null,
      inputSummary: {
        messageId: message?.id ?? null,
        addressed: decision.finalIsMentioned,
        ready: decision.ready,
      },
    }).catch(() => {});
  }

  if (respondError) {
    log?.error?.(
      `${LOG_PREFIX} respond step failed ${JSON.stringify({
        spaceId,
        threadKey,
        flowId,
        error: respondError.message ?? String(respondError),
      })}`
    );
    safeMutate('fail', bound, log, {
      flowId,
      expectedRevision: revision,
      stateJson: { outcome: 'respond-failed' },
      blockedSummary: String(respondError.message ?? respondError).slice(0, 200),
    });
    return;
  }

  safeMutate('finish', bound, log, {
    flowId,
    expectedRevision: revision,
    stateJson: { outcome: 'respond-complete', didSend: Boolean(respondResult?.didSend) },
  });
}

module.exports = {
  runMessageFlow,
};
