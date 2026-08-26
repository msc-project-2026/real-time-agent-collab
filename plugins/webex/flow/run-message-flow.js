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
// below and the phase-6 plan for why. Phase 7 adds a third sibling,
// summarize (v3 §9 recall/vector index) — same treatment, not chained (see
// §7b's own recommended sequencing: "pulling summarize out as a parallel
// sibling to extract"). All three settle independently; none blocks or fails
// either other, "maintain service" per the phase-6 plan's failure-handling
// section — the flow always reaches `finish`, with any per-step error
// captured in `stateJson` for later inspection rather than surfaced as a
// flow-level failure.
//
// Concurrency (phase 6 plan, "Concurrency — full design"; phase 7 extends
// it): lock layers on top of threads-store.js's own internal per-space write
// lock (layer 1).
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
// - Layer 2c (phase 7): the whole summarize step (spawn + write_summary/
//   search_recall tool calls) inside its own per-space lock
//   (`summarize:${spaceId}`) — recall-index.json/recall-supersession.json
//   are space-scoped files, same reasoning as layer 2b, but a separate lock
//   key since it's a different pair of files (no reason to serialize
//   summarize behind extract or vice versa).
// - respond acquires neither lock itself, but (response-policy revision,
//   phase 2) is no longer unconstrained relative to extract/task-notify —
//   it now runs sequenced *after* both settle, only when shouldRespond,
//   so it can be deterministically skipped when task-notify already sent
//   something for the triggering message. See the "respond" section below.
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
const { runSummarizeStep } = require('../processing/summarize/dispatch');
const { runTaskNotifyStep } = require('../processing/task-notify');
const { sendThinkingAck } = require('../processing/thinking-ack');
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

    const isBotMentioned =
      Array.isArray(message.mentionedPeople) && message.mentionedPeople.includes(botId);

    decision = decideDispatch({ tagResult, isBotMentioned });

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
          shouldRespond: decision.shouldRespond,
          sliceReady: decision.sliceReady,
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
      gateIsAddressed: tagResult?.messageTags?.isAddressed ?? null,
      gateConfigRequest: tagResult?.messageTags?.configRequest ?? null,
      gateSliceReady: tagResult?.pendingThreadWindowDecision?.sliceReady ?? null,
      isBotMentioned: decision.isBotMentioned,
      isBotAddressed: decision.isBotAddressed,
      shouldRespond: decision.shouldRespond,
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
    await handleConfigRequest({ spaceId, threadKey, message, account, botId, log, sendFn });
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

  // -- thinking placeholder — sent immediately once addressing is
  // confirmed, before extract/summarize/respond run. Stands in for a
  // typing indicator (Webex's bot API has no such endpoint); deliberately
  // never recorded to the thread window (see processing/thinking-ack.js).
  // Best-effort — a failure here must never block the rest of the flow.
  if (decision.shouldRespond) {
    await sendThinkingAck({ spaceId, threadKey, message, account, botId, log, sendFn }).catch(
      (err) =>
        log?.warn?.(
          `${LOG_PREFIX} thinking-ack failed ${JSON.stringify({
            spaceId,
            threadKey,
            flowId,
            error: errorMessage(err),
          })}`
        )
    );
  }

  // -- extract (layer 2b) + summarize (layer 2c), run together, not
  // chained. respond no longer runs alongside these — see below: it's
  // sequenced after task-notify so it can be skipped deterministically
  // when task-notify already covered the triggering message. --
  const extractStartedAt = new Date().toISOString();
  const summarizeStartedAt = new Date().toISOString();

  const [extractSettled, summarizeSettled] = await Promise.allSettled([
    withLock(`extract:${spaceId}`, () =>
      runExtractStep({ pluginRuntime, spaceId, threadKey, messageIds, log })
    ),
    withLock(`summarize:${spaceId}`, () =>
      runSummarizeStep({ pluginRuntime, spaceId, threadKey, messageIds, log })
    ),
  ]);

  const extractEndedAt = new Date().toISOString();
  const summarizeEndedAt = new Date().toISOString();

  const extractResult = extractSettled.status === 'fulfilled' ? extractSettled.value : null;
  const extractError = extractSettled.status === 'rejected' ? extractSettled.reason : null;
  const summarizeResult = summarizeSettled.status === 'fulfilled' ? summarizeSettled.value : null;
  const summarizeError = summarizeSettled.status === 'rejected' ? summarizeSettled.reason : null;

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
      step: 'summarize',
      runId: summarizeResult?.runId ?? null,
      sessionKey: summarizeResult?.sessionKey ?? null,
      startedAt: summarizeStartedAt,
      endedAt: summarizeEndedAt,
      outcome: summarizeError ? 'error' : 'success',
      error: errorMessage(summarizeError),
      toolCalls: summarizeResult?.toolCalls ?? null,
      inputSummary: {
        messageId: message?.id ?? null,
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

  if (summarizeError) {
    log?.error?.(
      `${LOG_PREFIX} summarize step failed ${JSON.stringify({
        spaceId,
        threadKey,
        flowId,
        error: errorMessage(summarizeError),
      })}`
    );
  }

  // -- task-notify (deterministic, no model call) — runs after extract has
  // landed, not inside the settle block above, since it reads what extract
  // just wrote. Skipped entirely on extract failure: nothing new to notify
  // about, and reading tasks.json right after a failed write isn't useful.
  const taskNotifyStartedAt = new Date().toISOString();
  let taskNotifyResult = null;
  let taskNotifyError = null;

  if (!extractError) {
    try {
      taskNotifyResult = await runTaskNotifyStep({
        spaceId,
        threadKey,
        messageIds,
        message,
        account,
        botId,
        log,
        sendFn,
        // Anything write_task delegated during this run's extract step
        // timestamps at-or-after this — the signal task-notify uses to tell
        // "just auto-approved this batch" apart from "was already delegated
        // a while ago, just touched again for an unrelated reason."
        sinceTimestamp: extractStartedAt,
      });
    } catch (err) {
      taskNotifyError = err;
    }
  }

  const taskNotifyEndedAt = new Date().toISOString();

  if (flowId) {
    await appendJobLogEntry({
      spaceId,
      flowId,
      step: 'task-notify',
      startedAt: taskNotifyStartedAt,
      endedAt: taskNotifyEndedAt,
      outcome: extractError ? 'skipped' : taskNotifyError ? 'error' : 'success',
      error: errorMessage(taskNotifyError),
      inputSummary: {
        messageId: message?.id ?? null,
        notified: taskNotifyResult?.notified?.length ?? null,
      },
    }).catch(() => {});
  }

  if (taskNotifyError) {
    log?.error?.(
      `${LOG_PREFIX} task-notify step failed ${JSON.stringify({
        spaceId,
        threadKey,
        flowId,
        error: errorMessage(taskNotifyError),
      })}`
    );
  }

  // -- respond — sequenced after extract/task-notify (a deliberate reversal
  // of the earlier "not delayed behind a slow extract" property), so it can
  // be skipped deterministically rather than narrating something
  // task-notify already announced. Only the *last* message in a flushed
  // batch could possibly be the one responsible for shouldRespond (gate
  // evaluation runs fresh per message and flushes immediately once
  // shouldRespond/sliceReady fires — see docs §5) — task-notify's
  // `coversLastMessage` tells us whether it already sent something tied to
  // that exact message.
  const skipRespondForTaskNotify = Boolean(
    taskNotifyResult?.notified?.some((entry) => entry.coversLastMessage)
  );

  const respondStartedAt = new Date().toISOString();

  let respondResult = null;
  let respondError = null;

  if (decision.shouldRespond && !skipRespondForTaskNotify) {
    try {
      respondResult = await runRespondStep({
        pluginRuntime,
        spaceId,
        threadKey,
        message,
        decision,
        messageIds,
        account,
        log,
      });
    } catch (err) {
      respondError = err;
    }
  } else {
    respondResult = {
      outcome: 'skipped',
      error: null,
      toolCalls: null,
      sessionKey: null,
      runId: null,
      didSend: false,
    };
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
      outcome: respondError ? 'error' : respondResult?.outcome ?? 'success',
      error: errorMessage(respondError),
      toolCalls: respondResult?.toolCalls ?? null,
      inputSummary: {
        messageId: message?.id ?? null,
        shouldRespond: decision.shouldRespond,
        skipRespondForTaskNotify,
        sliceReady: decision.sliceReady,
        pendingCount: messageIds.length,
      },
    }).catch(() => {});
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

  // Finalize regardless of any step's outcome — the batch was already
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
      summarizeError: Boolean(summarizeError),
      respondError: Boolean(respondError),
      taskNotifyError: Boolean(taskNotifyError),
      didSend: Boolean(respondResult?.didSend),
    },
  });
}

module.exports = {
  runMessageFlow,
};
