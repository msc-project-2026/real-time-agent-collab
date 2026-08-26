// ********* PROCESSING/SUMMARIZE/DISPATCH.JS *********
'use strict';

// v3 §9 recall — phase 7's new step, parallel sibling to extract (see
// flow/run-message-flow.js: all three of extract/respond/summarize run
// independently via Promise.allSettled, not chained). Isolated,
// non-persistent turn (v3 §8a), same shape as the other steps — fresh temp
// session file per call, discarded after.
//
// Message tool disabled, like extract: this step never communicates, its
// whole job is deciding what to write via write_summary. Callers must wrap
// this in flow/keyed-lock.js's per-space summarize lock (`summarize:${spaceId}`)
// — see run-message-flow.js — since recall-index.json/recall-supersession.json
// are space-scoped files, not thread-scoped; this module does not lock itself.

const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const { getThread } = require('../../storage/threads-store');
const { readRecallEntries } = require('../../storage/recall-store');
const { safeSegment } = require('../../storage/paths');
const { buildSummarizeInstruction } = require('./instruction');
const { getCollabAgentId } = require('../../runtime');

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_RECENT_SUMMARY_COUNT = 3;

// Deterministic, same-thread-only continuity context — a distinct, cheaper
// concern from search_recall's space-wide, model-driven search (see
// instruction.js). Plain filter over the space-wide entries list, same style
// as storage/tasks-store.js's own in-memory filtering.
async function getRecentThreadSummaries({
  spaceId,
  threadKey,
  explicitRoot,
  limit = DEFAULT_RECENT_SUMMARY_COUNT,
}) {
  const entries = await readRecallEntries({ spaceId, explicitRoot });

  return entries
    .filter((entry) => entry.thread_id === threadKey)
    .sort((a, b) => new Date(b.created_at ?? 0).getTime() - new Date(a.created_at ?? 0).getTime())
    .slice(0, limit);
}

async function runSummarizeStep({
  pluginRuntime,
  spaceId,
  threadKey,
  messageIds,
  log,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  explicitRoot,
}) {
  if (!spaceId) throw new Error('spaceId is required');
  if (!threadKey) throw new Error('threadKey is required');
  if (!Array.isArray(messageIds)) throw new Error('messageIds array is required');

  const window = await getThread({ spaceId, threadKey, explicitRoot });
  const recentSummaries = await getRecentThreadSummaries({ spaceId, threadKey, explicitRoot });

  const instruction = buildSummarizeInstruction({
    spaceId,
    threadKey,
    window,
    messageIds,
    recentSummaries,
  });

  const agentId = getCollabAgentId();
  const sessionKey = `agent:${agentId}:webex:${spaceId}:summarize:${safeSegment(threadKey)}`;
  const runId = `summarize-${Date.now()}`;

  const cfg = pluginRuntime.config.current();
  const workspaceDir = pluginRuntime.agent.resolveAgentWorkspaceDir(cfg, agentId);
  const agentDir = pluginRuntime.agent.resolveAgentDir(cfg, agentId);

  let tempDir;
  let result;
  try {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'webex-summarize-'));
    const sessionFile = path.join(tempDir, 'session.jsonl');

    result = await pluginRuntime.agent.runEmbeddedAgent({
      sessionId: `${runId}-${Math.random().toString(36).slice(2, 10)}`,
      sessionKey,
      agentId,
      sessionFile,
      workspaceDir,
      agentDir,
      config: cfg,
      prompt: instruction,
      timeoutMs,
      runId,
      // Summarization-only — never sends. Same structural protection as the
      // tagging gate and extract.
      disableMessageTool: true,
      allowEmptyAssistantReplyAsSilent: true,
    });
  } finally {
    if (tempDir) {
      await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
    }
  }

  const toolCalls = readToolCallCount(result);

  log?.info?.(
    `[collab-agent:summarize] summarize step completed ${JSON.stringify({
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
  };
}

function readToolCallCount(result) {
  const calls = result?.meta?.toolSummary?.calls;
  return Number.isInteger(calls) && calls >= 0 ? calls : null;
}

module.exports = {
  runSummarizeStep,
  getRecentThreadSummaries,
};
