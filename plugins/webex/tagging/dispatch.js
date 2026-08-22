// ********* TAGGING/DISPATCH.JS *********
'use strict';

// v3 §4/§7a: the tagging gate as a bare, non-Task-Flow isolated agent turn.
// Originally spawned via `pluginRuntime.subagent.run`, which routes through
// gateway-method RPC dispatch and requires `operator.write` — a scope this
// deployment's HTTP-route-triggered runtime context never carries (routes
// registered with `auth: 'plugin'` get zero operator scope for their runtime
// calls, by design, regardless of device/config state). Switched to
// `pluginRuntime.agent.runEmbeddedAgent`, a lower-level, direct in-process
// execution primitive with no gateway-RPC/operator-scope layer at all — the
// same one core OpenClaw code uses for its own one-shot, throwaway LLM calls
// (e.g. session-slug generation). Phase 2 ran the subagent.run version in
// shadow mode only, for output-quality validation. Phase 3 makes it
// load-bearing: the caller awaits dispatchTaggingGate() and feeds the
// returned tag result into the deterministic dispatch decision
// (tagging/decide.js), replacing the routing LLM classifier. It still never
// throws — a failed/missing gate result resolves to `null`, which
// decideDispatch() treats as "fall back to the deterministic botIsMentioned
// flag alone."

const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

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
  next
    .catch(() => {})
    .finally(() => {
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

  const agentId = getRoutingAgentId();
  const sessionKey = `agent:${agentId}:webex:${spaceId}:tagging-gate:${safeSegment(threadKey)}`;
  const runId = `tagging-gate-${Date.now()}`;

  const cfg = pluginRuntime.config.current();
  const workspaceDir = pluginRuntime.agent.resolveAgentWorkspaceDir(
    cfg,
    agentId
  );
  const agentDir = pluginRuntime.agent.resolveAgentDir(cfg, agentId);

  // Isolated, non-persistent turn (v3 §8a) — a fresh temp session file per
  // call, discarded afterward, never accumulated or reused across gate runs.
  let tempDir;
  try {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'webex-tagging-gate-'));
    const sessionFile = path.join(tempDir, 'session.jsonl');

    await pluginRuntime.agent.runEmbeddedAgent({
      sessionId: `${runId}-${randomSessionSuffix()}`,
      sessionKey,
      agentId,
      sessionFile,
      workspaceDir,
      agentDir,
      config: cfg,
      prompt: instruction,
      timeoutMs: waitTimeoutMs,
      runId,
      // The gate is instructed to only ever call tag_message — never reply
      // with text (v3 §4). Without this, the harness's generic turn-
      // completeness check expects a message-tool call or text payload and
      // logs a spurious "incomplete turn" warning for every gate run.
      disableMessageTool: true,
      visible: true,
    });
  } finally {
    if (tempDir) {
      await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
    }
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

function randomSessionSuffix() {
  return Math.random().toString(36).slice(2, 10);
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

  if (!pluginRuntime?.agent?.runEmbeddedAgent) {
    log?.warn?.(
      '[webex] tagging gate spawn unavailable — runtime does not expose agent.runEmbeddedAgent'
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
