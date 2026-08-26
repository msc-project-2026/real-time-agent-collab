'use strict';

const assert = require('node:assert/strict');
const { describe, test } = require('node:test');

const { loadWithMocks, makeLog } = require('./helpers.cjs');

// ---------------------------------------------------------------------------
// Category: runExtractStep — the v3 §7c / phase 6 task-extraction step.
// Same isolated, fresh-context spawn shape as dispatchTaggingGate
// (tagging/dispatch.js) and respond (processing/respond.js), but
// extraction-only: disableMessageTool is always set (unlike respond), and
// it never returns didSend (unlike respond, it has nothing to send).
// ---------------------------------------------------------------------------

describe('runExtractStep', () => {
  function loadExtract(t, overrides = {}) {
    const collaborators = {
      getThread: t.mock.fn(async () => ({
        pending: [],
        processing: [
          { id: 'msg-1', senderName: 'Ada', content: 'Can someone fix the login bug?', botIsMentioned: false, datetime: null },
        ],
        processed: [],
      })),
      getActiveTasks: t.mock.fn(async () => []),
      getSpaceMembers: t.mock.fn(async () => []),
      getCollabAgentId: t.mock.fn(() => 'main'),
      ...overrides,
    };

    const loaded = loadWithMocks(require.resolve('../processing/extract/dispatch'), {
      [require.resolve('../storage/threads-store')]: {
        getThread: collaborators.getThread,
      },
      [require.resolve('../storage/tasks-store')]: {
        getActiveTasks: collaborators.getActiveTasks,
      },
      [require.resolve('../config/members')]: {
        getSpaceMembers: collaborators.getSpaceMembers,
      },
      [require.resolve('../runtime')]: {
        getCollabAgentId: collaborators.getCollabAgentId,
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

  test('runs an embedded agent turn with the message tool disabled and returns outcome metadata', async (t) => {
    const runCalls = [];
    const runEmbeddedAgent = t.mock.fn(async (params) => {
      runCalls.push(params);
      return {
        payloads: [{ text: 'done' }],
        meta: { toolSummary: { calls: 2 } },
      };
    });
    const pluginRuntime = makeAgentRuntime(t, { runEmbeddedAgent });
    const { runExtractStep } = loadExtract(t);

    const result = await runExtractStep({
      pluginRuntime,
      spaceId: 'space-1',
      threadKey: '__main__',
      messageIds: ['msg-1'],
      log: makeLog(t),
    });

    assert.equal(runEmbeddedAgent.mock.callCount(), 1);
    const params = runCalls[0];
    assert.equal(params.sessionKey, 'agent:main:webex:space-1:extract:__main__');
    assert.equal(params.agentId, 'main');
    assert.equal(params.workspaceDir, '/workspace/main');
    assert.equal(params.agentDir, '/workspace/main/.agent');
    // Unlike respond, extraction never sends — this must always be set.
    assert.equal(params.disableMessageTool, true);
    assert.match(params.prompt, /write_task/);
    assert.match(params.prompt, /Can someone fix the login bug\?/);

    assert.equal(result.outcome, 'success');
    assert.equal(result.toolCalls, 2);
    assert.equal(result.sessionKey, params.sessionKey);
    assert.equal(result.runId, params.runId);
  });

  test('includes active tasks in the prompt so the model can decide new vs. update', async (t) => {
    const runCalls = [];
    const runEmbeddedAgent = t.mock.fn(async (params) => {
      runCalls.push(params);
      return { payloads: [] };
    });
    const pluginRuntime = makeAgentRuntime(t, { runEmbeddedAgent });
    const { runExtractStep } = loadExtract(t, {
      getActiveTasks: t.mock.fn(async () => [
        { id: 'task_1', type: 'development', status: 'open', assigned: 'bob', deadline: 'unknown', child_tasks: [] },
      ]),
    });

    await runExtractStep({
      pluginRuntime,
      spaceId: 'space-1',
      threadKey: '__main__',
      messageIds: ['msg-1'],
      log: makeLog(t),
    });

    assert.match(runCalls[0].prompt, /task_1/);
    assert.match(runCalls[0].prompt, /"assigned": "bob"/);
  });

  test('includes space members in the prompt so assigned can resolve to a real id', async (t) => {
    const runCalls = [];
    const runEmbeddedAgent = t.mock.fn(async (params) => {
      runCalls.push(params);
      return { payloads: [] };
    });
    const pluginRuntime = makeAgentRuntime(t, { runEmbeddedAgent });
    const { runExtractStep } = loadExtract(t, {
      getSpaceMembers: t.mock.fn(async () => [
        { id: 'person-1', email: 'ada@example.com', name: 'Ada', source: 'webex' },
        { id: 'agent', name: 'Agent' },
      ]),
    });

    await runExtractStep({
      pluginRuntime,
      spaceId: 'space-1',
      threadKey: '__main__',
      messageIds: ['msg-1'],
      log: makeLog(t),
    });

    assert.match(runCalls[0].prompt, /"id": "person-1"/);
    assert.match(runCalls[0].prompt, /"name": "Ada"/);
    // Only id/name reach the prompt — email/source are irrelevant to the model.
    assert.doesNotMatch(runCalls[0].prompt, /ada@example\.com/);
  });

  test('propagates a spawn failure instead of swallowing it', async (t) => {
    const pluginRuntime = makeAgentRuntime(t, {
      runEmbeddedAgent: async () => {
        throw new Error('provider timeout');
      },
    });
    const { runExtractStep } = loadExtract(t);

    await assert.rejects(
      runExtractStep({
        pluginRuntime,
        spaceId: 'space-1',
        threadKey: '__main__',
        messageIds: ['msg-1'],
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
    const { runExtractStep } = loadExtract(t);

    await runExtractStep({
      pluginRuntime,
      spaceId: 'space-1',
      threadKey: '__main__',
      messageIds: ['msg-1'],
      log: makeLog(t),
    });

    await assert.rejects(fs.access(path.dirname(capturedSessionFile)));
  });
});
