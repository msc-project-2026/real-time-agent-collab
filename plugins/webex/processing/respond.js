// ********* PROCESSING/RESPOND.JS *********
'use strict';

// v3 phase 5 respond step — the flow's second step, spawned only when
// dispatch judged the message addressed or the thread ready (tagging/decide.js).
// Isolated, non-persistent turn (v3 §8a), same shape as the tagging gate
// (tagging/dispatch.js) — fresh temp session file per call, discarded after.
// Unlike the gate, the message tool stays enabled: this step's whole job is
// deciding whether to reply and sending if so, so it needs to actually be
// able to send (see the plan's "message delivery" note — trust the model +
// the standard message tool rather than inventing custom delivery logic).

const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const { getThread, MAIN_THREAD_KEY } = require('../context/threads-store');
const { safeSegment } = require('../storage/paths');
const { buildRespondInstruction } = require('./respond-instruction');
const { getRoutingAgentId } = require('../runtime');

const DEFAULT_TIMEOUT_MS = 30_000;

async function runRespondStep({
  pluginRuntime,
  spaceId,
  threadKey,
  message,
  decision,
  log,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  explicitRoot,
}) {
  if (!spaceId) throw new Error('spaceId is required');
  if (!threadKey) throw new Error('threadKey is required');

  const window = await getThread({ spaceId, threadKey, explicitRoot });

  const instruction = buildRespondInstruction({
    spaceId,
    threadKey,
    window,
    directive: {
      addressed: decision?.finalIsMentioned,
      ready: decision?.ready,
      reason: decision?.reason,
    },
  });

  const agentId = getRoutingAgentId();
  const sessionKey = `agent:${agentId}:webex:${spaceId}:respond:${safeSegment(threadKey)}`;
  const runId = `respond-${Date.now()}`;

  const cfg = pluginRuntime.config.current();
  const workspaceDir = pluginRuntime.agent.resolveAgentWorkspaceDir(cfg, agentId);
  const agentDir = pluginRuntime.agent.resolveAgentDir(cfg, agentId);

  // Replies always go into a thread, never posted bare in the main space —
  // the agent should always be replying under whatever message it understood
  // as addressing it. For a non-main thread, threadKey IS already the Webex
  // message id the thread is rooted at (context/threads-store.js's
  // getThreadKey), the exact value Webex needs as parentId. For a main-space
  // message, there's no existing thread to anchor to, so the reply threads
  // under the triggering message's own id instead, starting a new one —
  // confirmed against live thread data that Webex threading is flat (every
  // reply in a thread carries the same parentId as the root, not the
  // immediately-preceding message), so anchoring to the root/triggering
  // message id is correct either way, never a specific mid-thread reply.
  const replyThreadId = threadKey === MAIN_THREAD_KEY ? message?.id : threadKey;

  let tempDir;
  let result;
  try {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'webex-respond-'));
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
      // Message tool stays enabled (no disableMessageTool) — this step needs
      // to be able to actually send, unlike the gate.
      messageChannel: 'webex',
      currentChannelId: spaceId,
      // Both fields set defensively — confirmed both flow through to the
      // native message tool's reply-target resolution (agent-tools bundle),
      // not confirmed which one Webex's channel adapter actually consults.
      ...(replyThreadId
        ? { currentThreadTs: replyThreadId, messageThreadId: replyThreadId }
        : {}),
      allowEmptyAssistantReplyAsSilent: true,
    });
  } finally {
    if (tempDir) {
      await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
    }
  }

  const toolCalls = readToolCallCount(result);

  log?.info?.(
    `[collab-agent:respond] respond step completed ${JSON.stringify({
      spaceId,
      threadKey,
      runId,
      sessionKey,
      toolCalls,
      didSend: Boolean(result?.didSendViaMessagingTool),
    })}`
  );

  return {
    outcome: 'success',
    error: null,
    toolCalls,
    sessionKey,
    runId,
    didSend: Boolean(result?.didSendViaMessagingTool),
  };
}

function readToolCallCount(result) {
  const calls = result?.meta?.toolSummary?.calls;
  return Number.isInteger(calls) && calls >= 0 ? calls : null;
}

module.exports = {
  runRespondStep,
};
