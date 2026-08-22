'use strict';

const assert = require('node:assert/strict');
const { describe, test } = require('node:test');

const { loadWithMocks, makeLog } = require('./helpers.cjs');

// ---------------------------------------------------------------------------
// Category: runRespondStep — the v3 phase 5 respond step. Same isolated,
// fresh-context spawn shape as dispatchTaggingGate (tagging/dispatch.js),
// but with the message tool left enabled since this step's job is deciding
// whether to reply and sending if so.
// ---------------------------------------------------------------------------

describe('runRespondStep', () => {
  function loadRespond(t, overrides = {}) {
    const collaborators = {
      getThread: t.mock.fn(async () => ({
        pending: [
          { id: 'msg-1', senderName: 'Ada', content: 'hi', botIsMentioned: false, datetime: null, status: 'pending' },
        ],
        processed: [],
      })),
      getRoutingAgentId: t.mock.fn(() => 'main'),
      ...overrides,
    };

    const loaded = loadWithMocks(require.resolve('../processing/respond'), {
      [require.resolve('../context/threads-store')]: {
        getThread: collaborators.getThread,
      },
      [require.resolve('../runtime')]: {
        getRoutingAgentId: collaborators.getRoutingAgentId,
      },
    });
    t.after(loaded.restore);

    return { ...loaded.subject, collaborators };
  }

  function makeAgentRuntime(t, { runEmbeddedAgent } = {}) {
    return {
      config: { current: t.mock.fn(() => ({ agents: { defaults: {} } })) },
      agent: {
        resolveAgentWorkspaceDir: t.mock.fn(() => '/workspace/main'),
        resolveAgentDir: t.mock.fn(() => '/workspace/main/.agent'),
        runEmbeddedAgent: runEmbeddedAgent ?? t.mock.fn(async () => ({ payloads: [] })),
      },
    };
  }

  test('runs an embedded agent turn with the message tool enabled and returns outcome metadata', async (t) => {
    const runCalls = [];
    const runEmbeddedAgent = t.mock.fn(async (params) => {
      runCalls.push(params);
      return {
        payloads: [{ text: 'Sure, on it.' }],
        meta: { toolSummary: { calls: 1 } },
        didSendViaMessagingTool: true,
      };
    });
    const pluginRuntime = makeAgentRuntime(t, { runEmbeddedAgent });
    const { runRespondStep } = loadRespond(t);

    const result = await runRespondStep({
      pluginRuntime,
      spaceId: 'space-1',
      threadKey: '__main__',
      message: { id: 'msg-1' },
      decision: { finalIsMentioned: true, ready: false, reason: 'Addressed.' },
      log: makeLog(t),
    });

    assert.equal(runEmbeddedAgent.mock.callCount(), 1);
    const params = runCalls[0];
    assert.equal(params.sessionKey, 'agent:main:webex:space-1:respond:__main__');
    assert.equal(params.agentId, 'main');
    assert.equal(params.workspaceDir, '/workspace/main');
    assert.equal(params.agentDir, '/workspace/main/.agent');
    assert.equal(params.messageChannel, 'webex');
    assert.equal(params.currentChannelId, 'space-1');
    // Unlike the gate, disableMessageTool must not be set.
    assert.equal(params.disableMessageTool, undefined);
    assert.match(params.prompt, /addressed: true/);
    assert.match(params.prompt, /Ada/);

    assert.equal(result.outcome, 'success');
    assert.equal(result.toolCalls, 1);
    assert.equal(result.didSend, true);
    assert.equal(result.sessionKey, params.sessionKey);
    assert.equal(result.runId, params.runId);
  });

  test('reports didSend false and toolCalls 0 for a silent "done" reply', async (t) => {
    const pluginRuntime = makeAgentRuntime(t, {
      runEmbeddedAgent: async () => ({
        payloads: [{ text: 'done' }],
        meta: { toolSummary: { calls: 0 } },
        didSendViaMessagingTool: false,
      }),
    });
    const { runRespondStep } = loadRespond(t);

    const result = await runRespondStep({
      pluginRuntime,
      spaceId: 'space-1',
      threadKey: '__main__',
      message: { id: 'msg-1' },
      decision: { finalIsMentioned: false, ready: true, reason: 'Ready but not addressed.' },
      log: makeLog(t),
    });

    assert.equal(result.outcome, 'success');
    assert.equal(result.toolCalls, 0);
    assert.equal(result.didSend, false);
  });

  test('propagates a spawn failure instead of swallowing it', async (t) => {
    const pluginRuntime = makeAgentRuntime(t, {
      runEmbeddedAgent: async () => {
        throw new Error('provider timeout');
      },
    });
    const { runRespondStep } = loadRespond(t);

    await assert.rejects(
      runRespondStep({
        pluginRuntime,
        spaceId: 'space-1',
        threadKey: '__main__',
        message: { id: 'msg-1' },
        decision: { finalIsMentioned: true, ready: false, reason: 'Addressed.' },
        log: makeLog(t),
      }),
      /provider timeout/
    );
  });

  test('cleans up the temp session directory after the run', async (t) => {
    const fs = require('node:fs/promises');
    const path = require('node:path');
    let capturedSessionFile;
    const runEmbeddedAgent = t.mock.fn(async (params) => {
      capturedSessionFile = params.sessionFile;
      await assert.doesNotReject(fs.access(path.dirname(params.sessionFile)));
      return { payloads: [] };
    });
    const pluginRuntime = makeAgentRuntime(t, { runEmbeddedAgent });
    const { runRespondStep } = loadRespond(t);

    await runRespondStep({
      pluginRuntime,
      spaceId: 'space-1',
      threadKey: '__main__',
      message: { id: 'msg-1' },
      decision: { finalIsMentioned: true, ready: false, reason: 'Addressed.' },
      log: makeLog(t),
    });

    await assert.rejects(fs.access(path.dirname(capturedSessionFile)));
  });
});
