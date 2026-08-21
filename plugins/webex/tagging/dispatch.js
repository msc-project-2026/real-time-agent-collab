// ********* TAGGING/DISPATCH.JS *********
'use strict';

// v3 §4/§7a phase 2: the tagging gate as a bare, non-Task-Flow subagent spawn
// (`pluginRuntime.subagent.run`), run alongside the existing routing pipeline
// purely to validate its output quality — it does not control dispatch yet.
// Any failure here is caught and logged; it must never affect the routing
// pipeline it runs beside.

const { getPendingSlice } = require('../context/threads-store');
const { safeSegment } = require('../storage/paths');
const { buildTaggingInstruction } = require('./instruction');
const { takePendingTagResult } = require('./tool');
const { appendTaggingValidationRecord } = require('./validation-log');
const { getRoutingAgentId } = require('../runtime');

const DEFAULT_WAIT_TIMEOUT_MS = 15_000;

// Serialise gate runs per thread so a thread's pending tag result (keyed by
// spaceId+threadKey in tagging/tool.js) can never be raced by two concurrent
// gate calls for the same thread.
const taggingQueues = new Map();

function enqueueTaggingDispatch(queueKey, job) {
  const previous = taggingQueues.get(queueKey) ?? Promise.resolve();

  const next = previous.catch(() => {}).then(job);

  taggingQueues.set(queueKey, next);
  // Separate branch for cleanup so it doesn't affect what `next` resolves/
  // rejects with; catch here so a job failure doesn't surface as an
  // unhandled rejection on this branch (the caller still observes it via
  // the returned `next` promise).
  next.catch(() => {}).finally(() => {
    if (taggingQueues.get(queueKey) === next) {
      taggingQueues.delete(queueKey);
    }
  });

  return next;
}

async function runTaggingGate({
  pluginRuntime,
  spaceId,
  threadKey,
  message,
  log,
  waitTimeoutMs = DEFAULT_WAIT_TIMEOUT_MS,
  explicitRoot,
}) {
  const pendingSlice = await getPendingSlice({ spaceId, threadKey });

  const instruction = buildTaggingInstruction({
    spaceId,
    threadKey,
    pendingSlice,
  });

  const sessionKey = `agent:${getRoutingAgentId()}:webex:${spaceId}:tagging-gate:${safeSegment(threadKey)}`;

  const { runId } = await pluginRuntime.subagent.run({
    sessionKey,
    message: instruction,
    lightContext: true,
    deliver: false,
  });

  const waitResult = await pluginRuntime.subagent.waitForRun?.({
    runId,
    timeoutMs: waitTimeoutMs,
  });

  if (waitResult && waitResult.status !== 'ok') {
    log?.warn?.('[webex] tagging gate run did not complete cleanly', {
      spaceId,
      threadKey,
      runId,
      status: waitResult.status,
      error: waitResult.error,
    });
  }

  const tagResult = takePendingTagResult(spaceId, threadKey);

  if (!tagResult) {
    log?.warn?.(
      '[webex] tagging gate did not call tag_message — no result to validate',
      { spaceId, threadKey, runId }
    );
    return;
  }

  await appendTaggingValidationRecord({
    spaceId,
    threadKey,
    messageId: message?.id,
    runId,
    pendingSliceSize: pendingSlice.length,
    tagResult,
    explicitRoot,
  });
}

// Fire-and-forget entry point. Never throws — this is shadow-mode validation
// running alongside the routing pipeline, not on its critical path.
async function dispatchTaggingGate({
  pluginRuntime,
  spaceId,
  threadKey,
  message,
  log,
  waitTimeoutMs,
  explicitRoot,
}) {
  if (!spaceId) throw new Error('spaceId is required');
  if (!threadKey) throw new Error('threadKey is required');

  if (!pluginRuntime?.subagent?.run) {
    log?.warn?.(
      '[webex] tagging gate spawn unavailable — runtime does not expose subagent.run'
    );
    return;
  }

  const queueKey = `${spaceId}::${threadKey}`;

  try {
    await enqueueTaggingDispatch(queueKey, () =>
      runTaggingGate({
        pluginRuntime,
        spaceId,
        threadKey,
        message,
        log,
        waitTimeoutMs,
        explicitRoot,
      })
    );
  } catch (err) {
    log?.error?.('[webex] tagging gate spawn failed', {
      spaceId,
      threadKey,
      error: err?.message ?? String(err),
    });
  }
}

module.exports = {
  dispatchTaggingGate,
};
