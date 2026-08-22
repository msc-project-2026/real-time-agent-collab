// ********* TAGGING/DISPATCH.JS *********
'use strict';

// v3 §4/§7a: the tagging gate as a bare, non-Task-Flow subagent spawn
// (`pluginRuntime.subagent.run`). Phase 2 ran this in shadow mode only, for
// output-quality validation. Phase 3 makes it load-bearing: the caller awaits
// dispatchTaggingGate() and feeds the returned tag result into the
// deterministic dispatch decision (tagging/decide.js), replacing the routing
// LLM classifier. It still never throws — a failed/missing gate result
// resolves to `null`, which decideDispatch() treats as "fall back to the
// deterministic botIsMentioned flag alone."

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
    log?.warn?.(
      `[webex] tagging gate run did not complete cleanly ${JSON.stringify({
        spaceId,
        threadKey,
        runId,
        status: waitResult.status,
        error: waitResult.error,
      })}`
    );
  }

  const tagResult = takePendingTagResult(spaceId, threadKey);

  if (!tagResult) {
    log?.warn?.(
      `[webex] tagging gate did not call tag_message — no result to validate ${JSON.stringify(
        { spaceId, threadKey, runId }
      )}`
    );
    return null;
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

  return tagResult;
}

// Entry point. Never throws — resolves to the tag result on success, or
// `null` if the gate is unavailable, fails, or never calls tag_message. The
// caller (inbound/message.js) awaits this and feeds the result into
// deterministic dispatch (tagging/decide.js).
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
    return null;
  }

  const queueKey = `${spaceId}::${threadKey}`;

  try {
    return await enqueueTaggingDispatch(queueKey, () =>
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
    log?.error?.(
      `[webex] tagging gate spawn failed ${JSON.stringify({
        spaceId,
        threadKey,
        error: err?.message ?? String(err),
        stack: err?.stack ?? null,
      })}`
    );
    return null;
  }
}

module.exports = {
  dispatchTaggingGate,
};
