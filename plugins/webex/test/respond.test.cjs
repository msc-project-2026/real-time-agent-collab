'use strict';

const assert = require('node:assert/strict');
const { describe, test } = require('node:test');

const { loadWithMocks, makeLog } = require('./helpers.cjs');

// resolveReplyThreadId's own correctness (main vs. existing thread, the
// root-mention lookup) is covered directly in test/send-outbound.test.cjs
// against real storage. Mocked here to the same simple contract — these
// tests are about runRespondStep's own wiring, not re-deriving that logic.
async function resolveReplyThreadId({ threadKey, message, isBotMentioned }) {
  if (!isBotMentioned) return null;
  return threadKey === '__main__' ? message?.id : threadKey;
}

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
        pending: [],
        processing: [
          { id: 'msg-1', senderName: 'Ada', content: 'hi', botIsMentioned: false, datetime: null },
        ],
        processed: [],
      })),
      getActiveTasks: t.mock.fn(async () => []),
      getSpaceMembers: t.mock.fn(async () => []),
      getCollabAgentId: t.mock.fn(() => 'main'),
      ...overrides,
    };

    const loaded = loadWithMocks(require.resolve('../processing/respond/dispatch'), {
      [require.resolve('../storage/threads-store')]: {
        getThread: collaborators.getThread,
        MAIN_THREAD_KEY: '__main__',
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
      [require.resolve('../send')]: {
        resolveReplyThreadId,
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
      messageIds: ['msg-1'],
      decision: { shouldRespond: true, ready: false, reason: 'Addressed.', isBotMentioned: true },
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
    assert.match(params.prompt, /reason: Addressed\./);
    assert.match(params.prompt, /Ada/);
    // No context-level currentThreadTs/messageThreadId — deliberately not
    // set, to avoid confounding the diagnostic test with an unconfirmed
    // mechanism. The model is told to set threadId/replyTo itself instead.
    assert.equal(params.currentThreadTs, undefined);
    assert.equal(params.messageThreadId, undefined);
    assert.match(params.prompt, /set its `replyTo` parameter to `msg-1`/);

    assert.equal(result.outcome, 'success');
    assert.equal(result.toolCalls, 1);
    assert.equal(result.didSend, true);
    assert.equal(result.sessionKey, params.sessionKey);
    assert.equal(result.runId, params.runId);
  });

  test('includes the space id and a derived board URL in the prompt when the account has a webhook URL', async (t) => {
    const runCalls = [];
    const runEmbeddedAgent = t.mock.fn(async (params) => {
      runCalls.push(params);
      return { payloads: [] };
    });
    const pluginRuntime = makeAgentRuntime(t, { runEmbeddedAgent });
    const { runRespondStep } = loadRespond(t);

    await runRespondStep({
      pluginRuntime,
      spaceId: 'space-1',
      threadKey: '__main__',
      message: { id: 'msg-1' },
      messageIds: ['msg-1'],
      decision: { shouldRespond: true, ready: false, reason: 'Addressed.', isBotMentioned: true },
      account: {
        config: {
          botWebhookUrl: 'https://example.up.railway.app/webhooks/webex/bot/default',
        },
      },
      log: makeLog(t),
    });

    assert.match(runCalls[0].prompt, /This Webex space's id: `space-1`/);
    assert.match(
      runCalls[0].prompt,
      /Task board URL for this space: https:\/\/example\.up\.railway\.app\/webex\/collab\/board\?spaceId=space-1/
    );
  });

  test('omits the board URL fact (without crashing) when the account has no usable webhook URL', async (t) => {
    const runCalls = [];
    const runEmbeddedAgent = t.mock.fn(async (params) => {
      runCalls.push(params);
      return { payloads: [] };
    });
    const pluginRuntime = makeAgentRuntime(t, { runEmbeddedAgent });
    const { runRespondStep } = loadRespond(t);

    await runRespondStep({
      pluginRuntime,
      spaceId: 'space-1',
      threadKey: '__main__',
      message: { id: 'msg-1' },
      messageIds: ['msg-1'],
      decision: { shouldRespond: true, ready: false, reason: 'Addressed.', isBotMentioned: true },
      // No account at all — mirrors any caller that hasn't threaded it through.
      log: makeLog(t),
    });

    assert.match(runCalls[0].prompt, /This Webex space's id: `space-1`/);
    assert.doesNotMatch(runCalls[0].prompt, /Task board URL/);
  });

  test('omits the board URL fact (without crashing) when botWebhookUrl is malformed', async (t) => {
    const runCalls = [];
    const runEmbeddedAgent = t.mock.fn(async (params) => {
      runCalls.push(params);
      return { payloads: [] };
    });
    const pluginRuntime = makeAgentRuntime(t, { runEmbeddedAgent });
    const { runRespondStep } = loadRespond(t);

    await runRespondStep({
      pluginRuntime,
      spaceId: 'space-1',
      threadKey: '__main__',
      message: { id: 'msg-1' },
      messageIds: ['msg-1'],
      decision: { shouldRespond: true, ready: false, reason: 'Addressed.', isBotMentioned: true },
      account: { config: { botWebhookUrl: 'not-a-url' } },
      log: makeLog(t),
    });

    assert.match(runCalls[0].prompt, /This Webex space's id: `space-1`/);
    assert.doesNotMatch(runCalls[0].prompt, /Task board URL/);
  });

  test('includes space members as a known fact so the model can address people correctly', async (t) => {
    const runCalls = [];
    const runEmbeddedAgent = t.mock.fn(async (params) => {
      runCalls.push(params);
      return { payloads: [] };
    });
    const pluginRuntime = makeAgentRuntime(t, { runEmbeddedAgent });
    const { runRespondStep } = loadRespond(t, {
      getSpaceMembers: t.mock.fn(async () => [
        { id: 'person-1', email: 'ada@example.com', name: 'Ada', source: 'webex' },
        { id: 'agent', name: 'Agent' },
      ]),
    });

    await runRespondStep({
      pluginRuntime,
      spaceId: 'space-1',
      threadKey: '__main__',
      message: { id: 'msg-1' },
      messageIds: ['msg-1'],
      decision: { shouldRespond: true, ready: false, reason: 'Addressed.', isBotMentioned: true },
      log: makeLog(t),
    });

    assert.match(runCalls[0].prompt, /### Space members/);
    assert.match(runCalls[0].prompt, /"id": "person-1"[\s\S]*"name": "Ada"/);
    assert.match(runCalls[0].prompt, /"id": "agent"[\s\S]*"name": "Agent"/);
    // email is real cached data but never shown to the model.
    assert.ok(!runCalls[0].prompt.includes('ada@example.com'));
  });

  test('resolves an active task\'s assigned id to the member\'s name, not the raw id', async (t) => {
    const runCalls = [];
    const runEmbeddedAgent = t.mock.fn(async (params) => {
      runCalls.push(params);
      return { payloads: [] };
    });
    const pluginRuntime = makeAgentRuntime(t, { runEmbeddedAgent });
    const { runRespondStep } = loadRespond(t, {
      getActiveTasks: t.mock.fn(async () => [
        { id: 'task_1', title: 'Fix login test', type: 'development', status: 'backlog', assigned: 'person-1' },
      ]),
      getSpaceMembers: t.mock.fn(async () => [
        { id: 'person-1', email: 'ada@example.com', name: 'Ada', source: 'webex' },
      ]),
    });

    await runRespondStep({
      pluginRuntime,
      spaceId: 'space-1',
      threadKey: '__main__',
      message: { id: 'msg-1' },
      messageIds: ['msg-1'],
      decision: { shouldRespond: true, ready: false, reason: 'Addressed.', isBotMentioned: true },
      log: makeLog(t),
    });

    assert.match(runCalls[0].prompt, /"assigned": "Ada"/);
    assert.ok(!runCalls[0].prompt.includes('"assigned": "person-1"'));
  });

  test('renders an empty space members list, without crashing, when the space has no members cached', async (t) => {
    const runCalls = [];
    const runEmbeddedAgent = t.mock.fn(async (params) => {
      runCalls.push(params);
      return { payloads: [] };
    });
    const pluginRuntime = makeAgentRuntime(t, { runEmbeddedAgent });
    const { runRespondStep } = loadRespond(t);

    await runRespondStep({
      pluginRuntime,
      spaceId: 'space-1',
      threadKey: '__main__',
      message: { id: 'msg-1' },
      messageIds: ['msg-1'],
      decision: { shouldRespond: true, ready: false, reason: 'Addressed.', isBotMentioned: true },
      log: makeLog(t),
    });

    assert.match(runCalls[0].prompt, /### Space members[\s\S]*```json\n\[\]\n```/);
  });

  test('threads a main-space reply under the triggering message, never posts bare to main', async (t) => {
    const runCalls = [];
    const runEmbeddedAgent = t.mock.fn(async (params) => {
      runCalls.push(params);
      return { payloads: [] };
    });
    const pluginRuntime = makeAgentRuntime(t, { runEmbeddedAgent });
    const { runRespondStep } = loadRespond(t);

    await runRespondStep({
      pluginRuntime,
      spaceId: 'space-1',
      threadKey: '__main__',
      message: { id: 'msg-1' },
      messageIds: ['msg-1'],
      decision: { shouldRespond: false, ready: true, reason: 'Ready.', isBotMentioned: true },
      log: makeLog(t),
    });

    assert.equal(runCalls[0].currentThreadTs, undefined);
    assert.equal(runCalls[0].messageThreadId, undefined);
    assert.match(runCalls[0].prompt, /set its `replyTo` parameter to `msg-1`/);
  });

  test('targets the reply thread for a non-main thread, so it does not land in the main space', async (t) => {
    const runCalls = [];
    const runEmbeddedAgent = t.mock.fn(async (params) => {
      runCalls.push(params);
      return { payloads: [] };
    });
    const pluginRuntime = makeAgentRuntime(t, { runEmbeddedAgent });
    const { runRespondStep } = loadRespond(t);

    await runRespondStep({
      pluginRuntime,
      spaceId: 'space-1',
      threadKey: 'thread-root-message-1',
      message: { id: 'msg-1' },
      messageIds: ['msg-1'],
      decision: { shouldRespond: true, ready: false, reason: 'Addressed.', isBotMentioned: true },
      log: makeLog(t),
    });

    assert.equal(runCalls[0].currentThreadTs, undefined);
    assert.equal(runCalls[0].messageThreadId, undefined);
    assert.match(runCalls[0].prompt, /set its `replyTo` parameter to `thread-root-message-1`/);
  });

  // Webex bots can only see messages that @-mention them — a platform
  // restriction, not a bug (see send.js's resolveReplyThreadId). A message
  // judged addressed via the gate's own semantic inference alone
  // (isBotMentioned: false) is invisible to the bot's own token, so using
  // it — or an existing thread's root — as parentId would 400 with "Parent
  // activity ID not found or invalid." Instructing the model to target
  // `null` posts bare in the main space instead, the correct safe fallback.
  test('instructs the model to omit replyTo (post bare in main) when the bot was not actually @-mentioned', async (t) => {
    const runCalls = [];
    const runEmbeddedAgent = t.mock.fn(async (params) => {
      runCalls.push(params);
      return { payloads: [] };
    });
    const pluginRuntime = makeAgentRuntime(t, { runEmbeddedAgent });
    const { runRespondStep } = loadRespond(t);

    await runRespondStep({
      pluginRuntime,
      spaceId: 'space-1',
      threadKey: 'thread-root-message-1',
      message: { id: 'msg-1' },
      messageIds: ['msg-1'],
      decision: { shouldRespond: true, ready: false, reason: 'Addressed.', isBotMentioned: false },
      log: makeLog(t),
    });

    assert.match(runCalls[0].prompt, /do not set `replyTo` at all/);
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
      messageIds: ['msg-1'],
      decision: { shouldRespond: false, ready: true, reason: 'Ready but not addressed.' },
      log: makeLog(t),
    });

    assert.equal(result.outcome, 'success');
    assert.equal(result.toolCalls, 0);
    assert.equal(result.didSend, false);
  });

  test('mentions search_recall alongside search_tasks in the tools-available section (v3 §9, phase 7)', async (t) => {
    const runCalls = [];
    const runEmbeddedAgent = t.mock.fn(async (params) => {
      runCalls.push(params);
      return { payloads: [] };
    });
    const pluginRuntime = makeAgentRuntime(t, { runEmbeddedAgent });
    const { runRespondStep } = loadRespond(t);

    await runRespondStep({
      pluginRuntime,
      spaceId: 'space-1',
      threadKey: '__main__',
      message: { id: 'msg-1' },
      messageIds: ['msg-1'],
      decision: { shouldRespond: true, ready: false, reason: 'Addressed.', isBotMentioned: true },
      log: makeLog(t),
    });

    assert.match(runCalls[0].prompt, /search_recall/);
    assert.match(runCalls[0].prompt, /search_tasks/);
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
      messageIds: ['msg-1'],
        decision: { shouldRespond: true, ready: false, reason: 'Addressed.', isBotMentioned: true },
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
      messageIds: ['msg-1'],
      decision: { shouldRespond: true, ready: false, reason: 'Addressed.', isBotMentioned: true },
      log: makeLog(t),
    });

    await assert.rejects(fs.access(path.dirname(capturedSessionFile)));
  });
});
