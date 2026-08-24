// ********* PROCESSING/RESPOND/DISPATCH.JS *********
'use strict';

// v3 phase 5 respond step — the flow's second step, spawned only when
// dispatch judged the message addressed or the thread ready (gate/decide.js).
// Isolated, non-persistent turn (v3 §8a), same shape as the tagging gate
// (gate/dispatch.js) — fresh temp session file per call, discarded after.
// Unlike the gate, the message tool stays enabled: this step's whole job is
// deciding whether to reply and sending if so, so it needs to actually be
// able to send (see the plan's "message delivery" note — trust the model +
// the standard message tool rather than inventing custom delivery logic).

const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const { getThread, MAIN_THREAD_KEY } = require('../../storage/threads-store');
const { getActiveTasks } = require('../../storage/tasks-store');
const { safeSegment } = require('../../storage/paths');
const { buildRespondInstruction } = require('./instruction');
const { getRoutingAgentId } = require('../../runtime');

const DEFAULT_TIMEOUT_MS = 30_000;

// The model has no way to know the space's own id or the board's URL on its
// own — it's not something an LLM should ever guess or fabricate. Derived
// from the account's own webhook URL (the one piece of config that reliably
// carries the deployment's public host) rather than requiring new config.
// Returns null if it can't be derived (e.g. account/config missing in a
// test double) — the prompt just omits the fact rather than showing a
// broken link.
function deriveBoardUrl({ account, spaceId }) {
  const webhookUrl = account?.config?.botWebhookUrl;
  if (!webhookUrl) return null;

  try {
    const origin = new URL(webhookUrl).origin;
    return `${origin}/webex/collab/board?spaceId=${encodeURIComponent(spaceId)}`;
  } catch {
    return null;
  }
}

async function runRespondStep({
  pluginRuntime,
  spaceId,
  threadKey,
  message,
  decision,
  messageIds,
  account,
  log,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  explicitRoot,
}) {
  if (!spaceId) throw new Error('spaceId is required');
  if (!threadKey) throw new Error('threadKey is required');
  if (!Array.isArray(messageIds)) throw new Error('messageIds array is required');

  const window = await getThread({ spaceId, threadKey, explicitRoot });
  const activeTasks = await getActiveTasks({ spaceId, explicitRoot });
  const knownFacts = { spaceId, boardUrl: deriveBoardUrl({ account, spaceId }) };

  // Replies always go into a thread, never posted bare in the main space —
  // the agent should always be replying under whatever message it understood
  // as addressing it. For a non-main thread, threadKey IS already the Webex
  // message id the thread is rooted at (storage/threads-store.js's
  // getThreadKey), the exact value Webex needs as parentId. For a main-space
  // message, there's no existing thread to anchor to, so the reply threads
  // under the triggering message's own id instead, starting a new one —
  // confirmed against live thread data that Webex threading is flat (every
  // reply in a thread carries the same parentId as the root, not the
  // immediately-preceding message), so anchoring to the root/triggering
  // message id is correct either way, never a specific mid-thread reply.
  //
  // Threading has been wrong twice in a row from static bundle reading alone
  // (once mis-attributing a cron-tool field as the message tool's, once
  // over-trusting a plausible-looking passthrough for currentThreadTs that
  // was never actually confirmed against a live test — neither
  // currentThreadTs/messageThreadId alone nor an explicit prompt instruction
  // alone has ever worked in isolation). Deliberately NOT restoring the
  // context-level params this time — they'd confound the experiment. The
  // only thing kept is the explicit, model-facing instruction
  // (respond-instruction.js) to set `threadId`/`replyTo` on the tool call
  // itself, since that's a real, schema-confirmed mechanism. channel.js's
  // sendText/sendMedia now log the raw replyToId they receive, which will
  // show directly whether this works — read that before changing anything
  // else here.
  const replyThreadId = threadKey === MAIN_THREAD_KEY ? message?.id : threadKey;

  const instruction = buildRespondInstruction({
    spaceId,
    threadKey,
    window,
    messageIds,
    directive: {
      addressed: decision?.finalIsMentioned,
      ready: decision?.ready,
      reason: decision?.reason,
    },
    replyThreadId,
    activeTasks,
    knownFacts,
  });

  const agentId = getRoutingAgentId();
  const sessionKey = `agent:${agentId}:webex:${spaceId}:respond:${safeSegment(threadKey)}`;
  const runId = `respond-${Date.now()}`;

  const cfg = pluginRuntime.config.current();
  const workspaceDir = pluginRuntime.agent.resolveAgentWorkspaceDir(cfg, agentId);
  const agentDir = pluginRuntime.agent.resolveAgentDir(cfg, agentId);

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
      // Diagnostic only — ground truth for what the model actually sent and
      // where, since we've now guessed wrong twice about which field
      // controls Webex thread targeting, plus a way to tell a genuine
      // silent decision apart from a run that errored/timed out without
      // ever reaching a tool call. Remove once both are confirmed working
      // live and no longer need this to diagnose them.
      stopReason: result?.meta?.stopReason ?? null,
      payloadCount: Array.isArray(result?.payloads) ? result.payloads.length : null,
      messagingToolSentTargets: result?.messagingToolSentTargets ?? null,
      messagingToolSentTexts: result?.messagingToolSentTexts ?? null,
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
