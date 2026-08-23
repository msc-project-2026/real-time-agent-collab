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
// Phase 6 adds a second step, extract (v3 §7c task extraction), as a sibling
// to respond rather than a chained predecessor — see the concurrency design
// below and the phase-6 plan for why. Both settle independently; neither
// blocks or fails the other, "maintain service" per that plan's failure-
// handling section — the flow always reaches `finish`, with any per-step
// error captured in `stateJson` for later inspection rather than surfaced as
// a flow-level failure.
//
// Concurrency (phase 6 plan, "Concurrency — full design"): two lock layers
// on top of threads-store.js's own internal per-space write lock (layer 1).
// - Layer 2a: gate's LLM call + dispatch decision + flush, all inside one
//   per-thread lock (`gate:${spaceId}:${threadKey}`) — a thread's next
//   message can't start gating until this one's gate-and-flush has fully
//   landed. This also subsumes what tagging/dispatch.js's now-removed
//   taggingQueues used to guarantee (gate-call-only), widened to cover the
//   flush too.
// - Layer 2b: the whole extract step (spawn + every write_task call) inside
//   one per-space lock (`extract:${spaceId}`) — tasks.json/task-parents.json
//   are space-scoped files (storage/paths.js), not thread-scoped, so
//   extraction must serialize space-wide, not just per thread.
// - respond acquires neither lock — genuinely unconstrained, best effort
//   with whatever's readable at call time.
//
// Replaces the old sequence in inbound/message.js (dispatchTaggingGate ->
// decideDispatch -> handleStagePendingBatchRequest) and the phase-4
// tagging/flow-spike.js probe, now superseded.

const { dispatchTaggingGate } = require('../processing/gate/dispatch');
const { decideDispatch } = require('../processing/gate/decide');
const { handleConfigRequest } = require('../config/handle-request');
const {
  getPendingSlice,
  markThreadMessagesProcessing,
  finalizeProcessingMessages,
  DEFAULT_PENDING_BACKSTOP_SIZE,
} = require('../storage/threads-store');
const { runRespondStep } = require('../processing/respond/dispatch');
const { runExtractStep } = require('../processing/extract/dispatch');
const { appendJobLogEntry } = require('./job-log');
const { withLock } = require('./keyed-lock');
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

function errorMessage(err) {
  if (!err) return null;
  return err.message ?? String(err);
}

async function runMessageFlow({
  spaceId,
  threadKey,
  message,
  botId,
  pendingCount,
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

  // -- gate + flush (layer 2a) — one critical section per thread. --
  const gateStartedAt = new Date().toISOString();

  let tagResult = null;
  let decision = null;
  let backstopTriggered = false;
  let shouldProcess = false;
  let messageIds = [];

  await withLock(`gate:${spaceId}:${threadKey}`, async () => {
    tagResult = await dispatchTaggingGate({
      pluginRuntime,
      spaceId,
      threadKey,
      message,
      botId,
      log,
    });

    const botIsMentioned =
      Array.isArray(message.mentionedPeople) && message.mentionedPeople.includes(botId);

    decision = decideDispatch({ tagResult, botIsMentioned });

    // v3 §2 backstop: a thread that never gets addressed and never gets
    // judged "ready" would otherwise accumulate pending messages
    // indefinitely (pending has no storage cap — see threads-store.js).
    // Forces a flush past this size regardless of the gate's judgment. Not
    // a primary trigger — the gate still runs and its judgment still
    // stands for everything except shouldProcess.
    backstopTriggered = pendingCount >= DEFAULT_PENDING_BACKSTOP_SIZE;
    shouldProcess = decision.shouldProcess || backstopTriggered;

    if (!shouldProcess) return;

    const pendingSlice = await getPendingSlice({ spaceId, threadKey });
    messageIds = pendingSlice.map((entry) => entry.id);

    log?.info?.(
      `${LOG_PREFIX} flushing pending slice ${JSON.stringify({
        spaceId,
        threadKey,
        flowId,
        pendingCount: messageIds.length,
      })}`
    );

    if (messageIds.length > 0) {
      await markThreadMessagesProcessing({ spaceId, threadKey, messageIds });
    }

    const resumed = safeMutate('resume', bound, log, {
      flowId,
      expectedRevision: revision,
      currentStep: 'process',
      stateJson: {
        directive: {
          addressed: decision.finalIsMentioned,
          ready: decision.ready,
          reason: decision.reason,
        },
        pendingCount: messageIds.length,
        backstopTriggered,
        messageIds,
      },
    });
    revision = resumed?.flow?.revision ?? revision;
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

  // Anchor line for understanding this message's outcome from logs alone —
  // same shape as before phase 5/6, just moved here from inbound/message.js.
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
      finalIsMentioned: decision.finalIsMentioned,
      configRequest: decision.configRequest,
      pendingCount: pendingCount ?? null,
      backstopTriggered,
      shouldProcess,
    })}`
  );

  // configRequest and shouldProcess are independent (both can fire for the
  // same message) — preserve that, matches pre-phase-5 behavior. Not part
  // of the gate lock: it's a side effect against Webex, not thread state,
  // and holding the lock for that network call would needlessly delay the
  // next message's gate cycle for this thread.
  if (decision.configRequest) {
    await handleConfigRequest({ spaceId, account, log, sendFn });
  }

  if (!shouldProcess) {
    const finished = safeMutate('finish', bound, log, {
      flowId,
      expectedRevision: revision,
      stateJson: { outcome: 'no-op' },
    });
    revision = finished?.flow?.revision ?? revision;
    return;
  }

  // -- extract (layer 2b) + respond (unlocked), run together, not chained. --
  const extractStartedAt = new Date().toISOString();
  const respondStartedAt = new Date().toISOString();

  const [extractSettled, respondSettled] = await Promise.allSettled([
    withLock(`extract:${spaceId}`, () =>
      runExtractStep({ pluginRuntime, spaceId, threadKey, messageIds, log })
    ),
    runRespondStep({
      pluginRuntime,
      spaceId,
      threadKey,
      message,
      decision,
      messageIds,
      log,
    }),
  ]);

  const extractEndedAt = new Date().toISOString();
  const respondEndedAt = new Date().toISOString();

  const extractResult = extractSettled.status === 'fulfilled' ? extractSettled.value : null;
  const extractError = extractSettled.status === 'rejected' ? extractSettled.reason : null;
  const respondResult = respondSettled.status === 'fulfilled' ? respondSettled.value : null;
  const respondError = respondSettled.status === 'rejected' ? respondSettled.reason : null;

  if (flowId) {
    await appendJobLogEntry({
      spaceId,
      flowId,
      step: 'extract',
      runId: extractResult?.runId ?? null,
      sessionKey: extractResult?.sessionKey ?? null,
      startedAt: extractStartedAt,
      endedAt: extractEndedAt,
      outcome: extractError ? 'error' : 'success',
      error: errorMessage(extractError),
      toolCalls: extractResult?.toolCalls ?? null,
      inputSummary: {
        messageId: message?.id ?? null,
        pendingCount: messageIds.length,
      },
    }).catch(() => {});

    await appendJobLogEntry({
      spaceId,
      flowId,
      step: 'respond',
      runId: respondResult?.runId ?? null,
      sessionKey: respondResult?.sessionKey ?? null,
      startedAt: respondStartedAt,
      endedAt: respondEndedAt,
      outcome: respondError ? 'error' : 'success',
      error: errorMessage(respondError),
      toolCalls: respondResult?.toolCalls ?? null,
      inputSummary: {
        messageId: message?.id ?? null,
        addressed: decision.finalIsMentioned,
        ready: decision.ready,
        pendingCount: messageIds.length,
      },
    }).catch(() => {});
  }

  if (extractError) {
    log?.error?.(
      `${LOG_PREFIX} extract step failed ${JSON.stringify({
        spaceId,
        threadKey,
        flowId,
        error: errorMessage(extractError),
      })}`
    );
  }

  if (respondError) {
    log?.error?.(
      `${LOG_PREFIX} respond step failed ${JSON.stringify({
        spaceId,
        threadKey,
        flowId,
        error: errorMessage(respondError),
      })}`
    );
  }

  // Finalize regardless of either step's outcome — the batch was already
  // claimed at flush time (now sitting in `processing`); leaving it there
  // forever on a step failure would just strand it. "Maintain service": the
  // flow always reaches `finish`, never `fail`, with per-step errors
  // captured in stateJson for later inspection instead of halting anything.
  if (messageIds.length > 0) {
    await finalizeProcessingMessages({ spaceId, threadKey, messageIds });
  }

  safeMutate('finish', bound, log, {
    flowId,
    expectedRevision: revision,
    stateJson: {
      outcome: 'process-complete',
      extractError: Boolean(extractError),
      respondError: Boolean(respondError),
      didSend: Boolean(respondResult?.didSend),
    },
  });
}

module.exports = {
  runMessageFlow,
};
