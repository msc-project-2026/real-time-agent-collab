// ********* PROCESSING/GATE/DISPATCH.JS *********
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
// (gate/decide.js), replacing the routing LLM classifier. It still never
// throws — a failed/missing gate result resolves to `null`, which
// decideDispatch() treats as "fall back to the deterministic botIsMentioned
// flag alone."

const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const { getThread } = require('../../storage/threads-store');
const { safeSegment } = require('../../storage/paths');
const { buildTaggingInstruction } = require('./instruction');
const { takePendingTagResult } = require('./tool');
const { appendTaggingValidationRecord } = require('./validation-log');
const { getCollabAgentId } = require('../../runtime');

const DEFAULT_WAIT_TIMEOUT_MS = 15_000;
// The gate's context is deliberately narrow (§4: pending slice only, cheap,
// no accumulated history) — but a short/empty pending slice on its own can
// leave the gate with zero surrounding context (e.g. a one-word reply in an
// ongoing thread whose prior messages already flushed to `processed`). Pad
// with a small, bounded tail of already-processed messages so the gate has
// at least this many messages of background, without re-opening full-window
// access (`processed` is already storage-capped at 10 — see threads-store.js).
const DEFAULT_MIN_CONTEXT_SIZE = 5;

async function runTaggingGate({
  pluginRuntime,
  spaceId,
  threadKey,
  message,
  botId,
  log,
  waitTimeoutMs = DEFAULT_WAIT_TIMEOUT_MS,
  minContextSize = DEFAULT_MIN_CONTEXT_SIZE,
  explicitRoot,
}) {
  const thread = await getThread({ spaceId, threadKey, explicitRoot });
  const pendingSlice = Array.isArray(thread.pending) ? thread.pending : [];
  const processed = Array.isArray(thread.processed) ? thread.processed : [];
  const recentProcessed = processed.slice(-minContextSize);

  const instruction = buildTaggingInstruction({
    spaceId,
    threadKey,
    pendingSlice,
    recentProcessed,
    botId,
  });

  const agentId = getCollabAgentId();
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
  let result;
  try {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'webex-tagging-gate-'));
    const sessionFile = path.join(tempDir, 'session.jsonl');

    result = await pluginRuntime.agent.runEmbeddedAgent({
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
      // No dedicated message/reply tool — the gate calls tag_message and
      // reports its own attempt count as plain text (see instruction.js),
      // never a channel reply.
      disableMessageTool: true,
      // Belt-and-suspenders: shouldTreatEmptyAssistantReplyAsSilent (embedded-
      // agent runtime) would otherwise flag a genuinely empty turn as
      // "incomplete" — moot now that the gate always replies with its
      // attempt-count line, but harmless to leave set. Still excludes
      // stopReason === "error", so a real dropped-connection/API failure is
      // unaffected and would still surface normally.
      allowEmptyAssistantReplyAsSilent: true,
    });
  } finally {
    if (tempDir) {
      await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
    }
  }

  const toolCallAttempts = readToolCallCount(result);

  const tagResult = takePendingTagResult(spaceId, threadKey);

  if (!tagResult) {
    log?.warn?.(
      `[collab-agent:tagging-dispatch] tagging gate did not call tag_message — no result to validate ${JSON.stringify(
        { spaceId, threadKey, runId, toolCallAttempts }
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
    toolCallAttempts,
    tagResult,
    explicitRoot,
  });

  // sessionKey/runId are attached to a fresh object here, after the
  // validation record above — that record is a pure audit trail of what
  // the model actually produced via tag_message, and shouldn't be
  // contaminated with plugin-internal call metadata. The caller
  // (run-message-flow.js) needs these two fields for its own job-log entry
  // and dispatch-decision log line, the same way extract/respond/summarize
  // already thread runId/sessionKey back to their callers.
  return { ...tagResult, sessionKey, runId };
}

function randomSessionSuffix() {
  return Math.random().toString(36).slice(2, 10);
}

// Ground-truth tool-call count from the embedded-agent runtime's own
// per-attempt record (toolMetas.length, surfaced as meta.toolSummary.calls) —
// not something the model self-reports. Diagnostic only: never gates
// dispatch, so a missing/malformed field just yields null rather than
// failing the run.
function readToolCallCount(result) {
  const calls = result?.meta?.toolSummary?.calls;
  return Number.isInteger(calls) && calls > 0 ? calls : null;
}

// Entry point. Never throws — resolves to the tag result on success, or
// `null` if the gate is unavailable, fails, or never calls tag_message. The
// caller (flow/run-message-flow.js) awaits this and feeds the result into
// deterministic dispatch (gate/decide.js).
//
// No per-thread locking here (phase 6 removed the queue this module used to
// own) — the caller now wraps this call together with the flush that
// follows it (markThreadMessagesProcessing) in one `withLock('gate:...')`
// critical section (flow/keyed-lock.js), so a thread's pending tag result
// (gate/tool.js) still can't be raced by a second concurrent gate call,
// and the flush that acts on this result can't race a second gate decision
// for the same thread either — a strictly wider guarantee than the old
// gate-only queue gave.
async function dispatchTaggingGate({
  pluginRuntime,
  spaceId,
  threadKey,
  message,
  botId,
  log,
  waitTimeoutMs,
  explicitRoot,
}) {
  if (!spaceId) throw new Error('spaceId is required');
  if (!threadKey) throw new Error('threadKey is required');

  if (!pluginRuntime?.agent?.runEmbeddedAgent) {
    log?.warn?.(
      '[collab-agent:tagging-dispatch] tagging gate spawn unavailable — runtime does not expose agent.runEmbeddedAgent'
    );
    return null;
  }

  try {
    return await runTaggingGate({
      pluginRuntime,
      spaceId,
      threadKey,
      message,
      botId,
      log,
      waitTimeoutMs,
      explicitRoot,
    });
  } catch (err) {
    log?.error?.(
      `[collab-agent:tagging-dispatch] tagging gate spawn failed ${JSON.stringify({
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
