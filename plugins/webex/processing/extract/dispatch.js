// ********* PROCESSING/EXTRACT/DISPATCH.JS *********
'use strict';

// v3 §7c task extraction — phase 6's new step, sibling to respond (see
// flow/run-message-flow.js: the two run independently via Promise.allSettled,
// not chained). Isolated, non-persistent turn (v3 §8a), same shape as the
// tagging gate (gate/dispatch.js) and respond (processing/respond/dispatch.js) —
// fresh temp session file per call, discarded after.
//
// Unlike respond, the message tool is disabled here: this step never
// communicates with anyone, its whole job is deciding what to write via
// write_task. Callers must wrap this in flow/keyed-lock.js's per-space
// extract lock (`extract:${spaceId}`) — see run-message-flow.js — since
// tasks.json/task-parents.json are space-scoped files, not thread-scoped;
// this module does not lock itself.

const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const { getThread } = require('../../storage/threads-store');
const { getActiveTasks } = require('../../storage/tasks-store');
const { getSpaceMembers } = require('../../config/members');
const { safeSegment } = require('../../storage/paths');
const { buildExtractInstruction } = require('./instruction');
const { usageFromEmbeddedResult } = require('../usage/from-result');
const { getCollabAgentId } = require('../../runtime');

const DEFAULT_TIMEOUT_MS = 30_000;

async function runExtractStep({
  pluginRuntime,
  spaceId,
  threadKey,
  messageIds,
  botId,
  log,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  explicitRoot,
}) {
  if (!spaceId) throw new Error('spaceId is required');
  if (!threadKey) throw new Error('threadKey is required');
  if (!Array.isArray(messageIds)) throw new Error('messageIds array is required');

  const window = await getThread({ spaceId, threadKey, explicitRoot });
  const activeTasks = await getActiveTasks({ spaceId, explicitRoot });
  const members = await getSpaceMembers({ spaceId, explicitRoot });

  const instruction = buildExtractInstruction({ spaceId, window, messageIds, activeTasks, members, botId });

  const agentId = getCollabAgentId();
  const sessionKey = `agent:${agentId}:webex:${spaceId}:extract:${safeSegment(threadKey)}`;
  const runId = `extract-${Date.now()}`;
  // Unique per spawn — the join key phase-8 usage capture uses to attribute
  // a `model.usage` event to this step run (sessionKey repeats per message).
  const sessionId = `${runId}-${Math.random().toString(36).slice(2, 10)}`;

  const cfg = pluginRuntime.config.current();
  const workspaceDir = pluginRuntime.agent.resolveAgentWorkspaceDir(cfg, agentId);
  const agentDir = pluginRuntime.agent.resolveAgentDir(cfg, agentId);

  let tempDir;
  let result;
  try {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'webex-extract-'));
    const sessionFile = path.join(tempDir, 'session.jsonl');

    result = await pluginRuntime.agent.runEmbeddedAgent({
      sessionId,
      sessionKey,
      agentId,
      sessionFile,
      workspaceDir,
      agentDir,
      config: cfg,
      prompt: instruction,
      timeoutMs,
      runId,
      // Extraction-only — never sends. Same structural protection as the
      // tagging gate (gate/dispatch.js), not just a prompt instruction.
      disableMessageTool: true,
      allowEmptyAssistantReplyAsSilent: true,
    });
  } finally {
    if (tempDir) {
      await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
    }
  }

  const toolCalls = readToolCallCount(result);
  const usage = usageFromEmbeddedResult(result);

  log?.info?.(
    `[collab-agent:extract] extract step completed ${JSON.stringify({
      spaceId,
      threadKey,
      runId,
      sessionKey,
      toolCalls,
      stopReason: result?.meta?.stopReason ?? null,
    })}`
  );

  return {
    outcome: 'success',
    error: null,
    toolCalls,
    sessionKey,
    runId,
    sessionId,
    usage,
  };
}

function readToolCallCount(result) {
  const calls = result?.meta?.toolSummary?.calls;
  return Number.isInteger(calls) && calls >= 0 ? calls : null;
}

module.exports = {
  runExtractStep,
};
