'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const { describe, test } = require('node:test');

const { loadWithMocks, makeLog, makeTempWorkspace } = require('./helpers.cjs');
const { taggingValidationLogPath } = require('../storage/paths');
const { buildTaggingInstruction } = require('../tagging/instruction');
const {
  appendMessageToThreadWindow,
} = require('../context/threads-store');

// ---------------------------------------------------------------------------
// Category: tag_message tool validation.
// Mirrors routing/tool.js's contract: invalid inputs return structured
// errors so the model can retry without the gateway throwing.
// ---------------------------------------------------------------------------

describe('tag_message tool validation', () => {
  function loadTool() {
    const resolved = require.resolve('../tagging/tool');
    delete require.cache[resolved];
    return require(resolved);
  }

  const validParams = {
    spaceId: 'space-1',
    threadKey: '__main__',
    isMentioned: true,
    configRequest: false,
    ready: true,
    reason: 'Contains a complete request.',
  };

  test('valid params store the split result and return ok', async () => {
    const { tagMessageTool, takePendingTagResult } = loadTool();
    const tool = tagMessageTool();

    const result = await tool.execute('id-1', validParams);

    assert.deepEqual(result, { ok: true });
    assert.deepEqual(takePendingTagResult('space-1', '__main__'), {
      messageTags: { isMentioned: true, configRequest: false },
      pendingThreadWindowDecision: {
        ready: true,
        reason: 'Contains a complete request.',
      },
    });
  });

  test('takePendingTagResult clears the entry after reading', async () => {
    const { tagMessageTool, takePendingTagResult } = loadTool();
    const tool = tagMessageTool();

    await tool.execute('id-1', validParams);
    takePendingTagResult('space-1', '__main__');

    assert.equal(takePendingTagResult('space-1', '__main__'), null);
  });

  test('results for different threads in the same space do not collide', async () => {
    const { tagMessageTool, takePendingTagResult } = loadTool();
    const tool = tagMessageTool();

    await tool.execute('id-1', { ...validParams, threadKey: 'thread-a', ready: true });
    await tool.execute('id-2', { ...validParams, threadKey: 'thread-b', ready: false });

    assert.equal(
      takePendingTagResult('space-1', 'thread-a').pendingThreadWindowDecision.ready,
      true
    );
    assert.equal(
      takePendingTagResult('space-1', 'thread-b').pendingThreadWindowDecision.ready,
      false
    );
  });

  test('missing threadKey returns validation error and does not store', async () => {
    const { tagMessageTool, takePendingTagResult } = loadTool();
    const tool = tagMessageTool();

    const result = await tool.execute('id-1', { ...validParams, threadKey: undefined });

    assert.equal(result.ok, false);
    assert.ok(result.errors.some((e) => e.includes('threadKey')));
    assert.equal(takePendingTagResult('space-1', '__main__'), null);
  });

  test('non-boolean isMentioned/configRequest/ready returns validation error', async () => {
    const { tagMessageTool } = loadTool();
    const tool = tagMessageTool();

    const result = await tool.execute('id-1', {
      ...validParams,
      isMentioned: 'yes',
      configRequest: 0,
      ready: 'true',
    });

    assert.equal(result.ok, false);
    assert.ok(result.errors.some((e) => e.includes('isMentioned')));
    assert.ok(result.errors.some((e) => e.includes('configRequest')));
    assert.ok(result.errors.some((e) => e.includes('ready')));
  });

  test('empty reason string returns validation error and does not store', async () => {
    const { tagMessageTool, takePendingTagResult } = loadTool();
    const tool = tagMessageTool();

    const result = await tool.execute('id-1', { ...validParams, reason: '   ' });

    assert.equal(result.ok, false);
    assert.ok(result.errors.some((e) => e.includes('reason')));
    assert.equal(takePendingTagResult('space-1', '__main__'), null);
  });
});

// ---------------------------------------------------------------------------
// Category: tagging instruction prompt building.
// ---------------------------------------------------------------------------

describe('buildTaggingInstruction', () => {
  test('embeds spaceId, threadKey, and the pending slice verbatim', () => {
    const pendingSlice = [
      {
        id: 'msg-1',
        senderName: 'Ada',
        content: 'Can we',
        botIsMentioned: false,
        datetime: '2026-08-21T09:00:00.000Z',
      },
      {
        id: 'msg-2',
        senderName: 'Ada',
        content: 'fix the login test?',
        botIsMentioned: true,
        datetime: '2026-08-21T09:00:05.000Z',
      },
    ];

    const instruction = buildTaggingInstruction({
      spaceId: 'space-1',
      threadKey: '__main__',
      pendingSlice,
    });

    assert.match(instruction, /tag_message/);
    assert.match(instruction, /space-1/);
    assert.match(instruction, /__main__/);
    assert.match(instruction, /fix the login test\?/);
    assert.match(instruction, /"botIsMentioned": true/);
    assert.match(instruction, /respond with exactly the word `done`/);
  });

  test('requires spaceId and threadKey', () => {
    assert.throws(() =>
      buildTaggingInstruction({ spaceId: '', threadKey: '__main__', pendingSlice: [] })
    );
    assert.throws(() =>
      buildTaggingInstruction({ spaceId: 'space-1', threadKey: '', pendingSlice: [] })
    );
  });

  test('tolerates a missing/non-array pendingSlice', () => {
    const instruction = buildTaggingInstruction({
      spaceId: 'space-1',
      threadKey: '__main__',
      pendingSlice: undefined,
    });

    assert.match(instruction, /\[\]/);
  });

  test('flags entries sent by the bot itself as fromAgent, so the model can recognize its own prior messages', () => {
    const pendingSlice = [
      {
        id: 'msg-1',
        senderId: 'bot-1',
        senderName: 'collab-agent@webex.bot',
        content: "Hey! Yes, I'm here. How can I help?",
        botIsMentioned: false,
        datetime: '2026-08-22T21:37:59.455Z',
      },
      {
        id: 'msg-2',
        senderId: 'person-1',
        senderName: 'Ada',
        content: 'Great, are you well?',
        botIsMentioned: false,
        datetime: '2026-08-22T21:41:34.635Z',
      },
    ];

    const instruction = buildTaggingInstruction({
      spaceId: 'space-1',
      threadKey: 'thread-1',
      pendingSlice,
      botId: 'bot-1',
    });

    const sliceJson = instruction.slice(
      instruction.indexOf('```json') + 7,
      instruction.lastIndexOf('```')
    );
    const parsed = JSON.parse(sliceJson);

    assert.equal(parsed[0].fromAgent, true);
    assert.equal(parsed[1].fromAgent, false);
    assert.match(instruction, /fromAgent/);
  });

  test('treats every entry as not-from-agent when botId is omitted', () => {
    const instruction = buildTaggingInstruction({
      spaceId: 'space-1',
      threadKey: '__main__',
      pendingSlice: [{ id: 'msg-1', senderId: 'bot-1', senderName: 'bot', content: 'hi' }],
    });

    const sliceJson = instruction.slice(
      instruction.indexOf('```json') + 7,
      instruction.lastIndexOf('```')
    );
    assert.equal(JSON.parse(sliceJson)[0].fromAgent, false);
  });
});

// ---------------------------------------------------------------------------
// Category: dispatchTaggingGate — the bare non-Task-Flow spawn.
// ---------------------------------------------------------------------------

describe('dispatchTaggingGate', () => {
  function loadDispatch(t, overrides = {}) {
    const collaborators = {
      getThread: t.mock.fn(async () => ({
        pending: [
          { id: 'msg-1', senderName: 'Ada', content: 'hi', botIsMentioned: false, datetime: null },
        ],
        processed: [],
      })),
      takePendingTagResult: t.mock.fn(() => ({
        messageTags: { isMentioned: true, configRequest: false },
        pendingThreadWindowDecision: { ready: true, reason: 'Complete ask.' },
      })),
      appendTaggingValidationRecord: t.mock.fn(async () => undefined),
      getRoutingAgentId: t.mock.fn(() => 'main'),
      ...overrides,
    };

    const loaded = loadWithMocks(require.resolve('../tagging/dispatch'), {
      [require.resolve('../context/threads-store')]: {
        getThread: collaborators.getThread,
      },
      [require.resolve('../tagging/tool')]: {
        takePendingTagResult: collaborators.takePendingTagResult,
      },
      [require.resolve('../tagging/validation-log')]: {
        appendTaggingValidationRecord: collaborators.appendTaggingValidationRecord,
      },
      [require.resolve('../runtime')]: {
        getRoutingAgentId: collaborators.getRoutingAgentId,
      },
    });
    t.after(loaded.restore);

    return { ...loaded.subject, collaborators };
  }

  // Builds a pluginRuntime stub matching the shape runTaggingGate expects:
  // config.current() plus agent.{resolveAgentWorkspaceDir,resolveAgentDir,runEmbeddedAgent}.
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

  test('runs an embedded agent turn with a per-thread session key and records the result', async (t) => {
    const runCalls = [];
    const runEmbeddedAgent = t.mock.fn(async (params) => {
      runCalls.push(params);
      return { payloads: [{ text: 'done' }], meta: { toolSummary: { calls: 1 } } };
    });
    const pluginRuntime = makeAgentRuntime(t, { runEmbeddedAgent });

    const { dispatchTaggingGate, collaborators } = loadDispatch(t);

    await dispatchTaggingGate({
      pluginRuntime,
      spaceId: 'space-1',
      threadKey: '__main__',
      message: { id: 'msg-1' },
      log: makeLog(t),
    });

    assert.equal(runEmbeddedAgent.mock.callCount(), 1);
    const params = runCalls[0];
    assert.equal(params.sessionKey, 'agent:main:webex:space-1:tagging-gate:__main__');
    assert.equal(params.agentId, 'main');
    assert.equal(params.workspaceDir, '/workspace/main');
    assert.equal(params.agentDir, '/workspace/main/.agent');
    assert.match(params.prompt, /tag_message/);
    assert.equal(params.timeoutMs, 15_000);
    assert.ok(params.sessionFile.endsWith('session.jsonl'));
    assert.ok(typeof params.sessionId === 'string' && params.sessionId.length > 0);
    assert.ok(typeof params.runId === 'string' && params.runId.length > 0);
    assert.equal(params.disableMessageTool, true);
    assert.equal(params.allowEmptyAssistantReplyAsSilent, true);

    assert.equal(collaborators.appendTaggingValidationRecord.mock.callCount(), 1);
    const record = collaborators.appendTaggingValidationRecord.mock.calls[0].arguments[0];
    assert.equal(record.spaceId, 'space-1');
    assert.equal(record.threadKey, '__main__');
    assert.equal(record.runId, params.runId);
    assert.equal(record.pendingSliceSize, 1);
    assert.equal(record.toolCallAttempts, 1);
    assert.deepEqual(record.tagResult.messageTags, { isMentioned: true, configRequest: false });
  });

  test('passes botId through so the gate can recognize its own prior messages', async (t) => {
    const runCalls = [];
    const runEmbeddedAgent = t.mock.fn(async (params) => {
      runCalls.push(params);
      return { payloads: [{ text: 'done' }] };
    });
    const pluginRuntime = makeAgentRuntime(t, { runEmbeddedAgent });

    const { dispatchTaggingGate } = loadDispatch(t, {
      getThread: t.mock.fn(async () => ({
        pending: [
          { id: 'msg-1', senderId: 'bot-1', senderName: 'bot', content: 'Hi there', botIsMentioned: false, datetime: null },
          { id: 'msg-2', senderId: 'person-1', senderName: 'Ada', content: 'Great, thanks', botIsMentioned: false, datetime: null },
        ],
        processed: [],
      })),
    });

    await dispatchTaggingGate({
      pluginRuntime,
      spaceId: 'space-1',
      threadKey: 'thread-1',
      message: { id: 'msg-2' },
      botId: 'bot-1',
      log: makeLog(t),
    });

    const promptSlice = JSON.parse(
      runCalls[0].prompt.slice(
        runCalls[0].prompt.indexOf('```json') + 7,
        runCalls[0].prompt.lastIndexOf('```')
      )
    );
    assert.equal(promptSlice[0].fromAgent, true);
    assert.equal(promptSlice[1].fromAgent, false);
  });

  test('reads a multi-attempt count from meta.toolSummary.calls (retried tag_message calls)', async (t) => {
    const pluginRuntime = makeAgentRuntime(t, {
      runEmbeddedAgent: async () => ({
        payloads: [{ text: 'done' }],
        meta: { toolSummary: { calls: 2, tools: ['tag_message'], failures: 1 } },
      }),
    });
    const { dispatchTaggingGate, collaborators } = loadDispatch(t);

    await dispatchTaggingGate({
      pluginRuntime,
      spaceId: 'space-1',
      threadKey: '__main__',
      message: { id: 'msg-1' },
      log: makeLog(t),
    });

    assert.equal(
      collaborators.appendTaggingValidationRecord.mock.calls[0].arguments[0].toolCallAttempts,
      2
    );
  });

  test('falls back to null when meta.toolSummary is missing or malformed', async (t) => {
    const pluginRuntime = makeAgentRuntime(t, {
      runEmbeddedAgent: async () => ({ payloads: [{ text: 'done' }] }),
    });
    const { dispatchTaggingGate, collaborators } = loadDispatch(t);

    await dispatchTaggingGate({
      pluginRuntime,
      spaceId: 'space-1',
      threadKey: '__main__',
      message: { id: 'msg-1' },
      log: makeLog(t),
    });

    assert.equal(
      collaborators.appendTaggingValidationRecord.mock.calls[0].arguments[0].toolCallAttempts,
      null
    );
  });

  test('cleans up the temp session directory after the run', async (t) => {
    const fs = require('node:fs/promises');
    let capturedSessionFile;
    const runEmbeddedAgent = t.mock.fn(async (params) => {
      capturedSessionFile = params.sessionFile;
      // The temp dir must exist while the run is in flight.
      await assert.doesNotReject(fs.access(require('node:path').dirname(params.sessionFile)));
      return { payloads: [] };
    });
    const pluginRuntime = makeAgentRuntime(t, { runEmbeddedAgent });
    const { dispatchTaggingGate } = loadDispatch(t);

    await dispatchTaggingGate({
      pluginRuntime,
      spaceId: 'space-1',
      threadKey: '__main__',
      message: { id: 'msg-1' },
      log: makeLog(t),
    });

    await assert.rejects(fs.access(require('node:path').dirname(capturedSessionFile)));
  });

  test('is a silent no-op when the runtime does not expose agent.runEmbeddedAgent', async (t) => {
    const { dispatchTaggingGate, collaborators } = loadDispatch(t);
    const log = makeLog(t);

    await dispatchTaggingGate({
      pluginRuntime: { channel: {} },
      spaceId: 'space-1',
      threadKey: '__main__',
      message: { id: 'msg-1' },
      log,
    });

    assert.equal(collaborators.getThread.mock.callCount(), 0);
    assert.equal(log.warn.mock.callCount(), 1);
  });

  test('never throws when the embedded agent run itself fails, and still cleans up', async (t) => {
    const runEmbeddedAgent = async () => {
      throw new Error('spawn exploded');
    };
    const pluginRuntime = makeAgentRuntime(t, { runEmbeddedAgent });
    const { dispatchTaggingGate, collaborators } = loadDispatch(t);
    const log = makeLog(t);

    await assert.doesNotReject(
      dispatchTaggingGate({
        pluginRuntime,
        spaceId: 'space-1',
        threadKey: '__main__',
        message: { id: 'msg-1' },
        log,
      })
    );

    assert.equal(log.error.mock.callCount(), 1);
    assert.equal(collaborators.appendTaggingValidationRecord.mock.callCount(), 0);
  });

  test('logs and skips validation recording when the gate never calls tag_message', async (t) => {
    const pluginRuntime = makeAgentRuntime(t);
    const { dispatchTaggingGate, collaborators } = loadDispatch(t, {
      takePendingTagResult: () => null,
    });
    const log = makeLog(t);

    await dispatchTaggingGate({
      pluginRuntime,
      spaceId: 'space-1',
      threadKey: '__main__',
      message: { id: 'msg-1' },
      log,
    });

    assert.equal(log.warn.mock.callCount(), 1);
    assert.equal(collaborators.appendTaggingValidationRecord.mock.callCount(), 0);
  });

  // dispatchTaggingGate no longer serializes concurrent runs itself (phase 6
  // removed the module-local taggingQueues) — the caller now wraps the gate
  // call together with the flush that follows it in one per-thread lock
  // (flow/keyed-lock.js's `gate:${spaceId}:${threadKey}`), a strictly wider
  // guarantee than the old gate-only queue gave. See
  // flow-orchestration.test.cjs for the serialization test at that level.
});

// ---------------------------------------------------------------------------
// Category: decideDispatch — v3 §5 deterministic dispatch, pure controller
// logic with no I/O. Phase 3: replaces the routing LLM classifier.
// ---------------------------------------------------------------------------

describe('decideDispatch', () => {
  const { decideDispatch } = require('../tagging/decide');

  test('neither mentioned, ready, nor configRequest: no dispatch', () => {
    const decision = decideDispatch({
      tagResult: {
        messageTags: { isMentioned: false, configRequest: false },
        pendingThreadWindowDecision: { ready: false, reason: 'Not yet.' },
      },
      botIsMentioned: false,
    });

    assert.deepEqual(decision, {
      finalIsMentioned: false,
      configRequest: false,
      ready: false,
      shouldProcess: false,
      reason: 'Not yet.',
    });
  });

  test('deterministic botIsMentioned alone is OR-ed in, independent of the gate', () => {
    const decision = decideDispatch({
      tagResult: {
        messageTags: { isMentioned: false, configRequest: false },
        pendingThreadWindowDecision: { ready: false, reason: 'Not judged mentioned.' },
      },
      botIsMentioned: true,
    });

    assert.equal(decision.finalIsMentioned, true);
    assert.equal(decision.shouldProcess, true);
  });

  test('gate-judged isMentioned alone is OR-ed in, independent of the deterministic flag', () => {
    const decision = decideDispatch({
      tagResult: {
        messageTags: { isMentioned: true, configRequest: false },
        pendingThreadWindowDecision: { ready: false, reason: 'Semantically addressed.' },
      },
      botIsMentioned: false,
    });

    assert.equal(decision.finalIsMentioned, true);
    assert.equal(decision.shouldProcess, true);
  });

  test('ready alone triggers shouldProcess without mention', () => {
    const decision = decideDispatch({
      tagResult: {
        messageTags: { isMentioned: false, configRequest: false },
        pendingThreadWindowDecision: { ready: true, reason: 'Complete ask.' },
      },
      botIsMentioned: false,
    });

    assert.equal(decision.finalIsMentioned, false);
    assert.equal(decision.ready, true);
    assert.equal(decision.shouldProcess, true);
  });

  test('mention and ready can both be true for the same message', () => {
    const decision = decideDispatch({
      tagResult: {
        messageTags: { isMentioned: true, configRequest: false },
        pendingThreadWindowDecision: { ready: true, reason: 'Both.' },
      },
      botIsMentioned: true,
    });

    assert.equal(decision.finalIsMentioned, true);
    assert.equal(decision.ready, true);
    assert.equal(decision.shouldProcess, true);
  });

  test('configRequest is independent of mention/ready and can co-occur', () => {
    const decision = decideDispatch({
      tagResult: {
        messageTags: { isMentioned: false, configRequest: true },
        pendingThreadWindowDecision: { ready: true, reason: 'Config ask plus a task.' },
      },
      botIsMentioned: false,
    });

    assert.equal(decision.configRequest, true);
    assert.equal(decision.shouldProcess, true);
  });

  test('a null tagResult (failed/missing gate) falls back to botIsMentioned alone', () => {
    const notMentioned = decideDispatch({ tagResult: null, botIsMentioned: false });
    assert.deepEqual(notMentioned, {
      finalIsMentioned: false,
      configRequest: false,
      ready: false,
      shouldProcess: false,
      reason: null,
    });

    const mentioned = decideDispatch({ tagResult: null, botIsMentioned: true });
    assert.equal(mentioned.finalIsMentioned, true);
    assert.equal(mentioned.shouldProcess, true);
  });
});

// ---------------------------------------------------------------------------
// Category: validation log — real filesystem write via a temp workspace.
// ---------------------------------------------------------------------------

describe('appendTaggingValidationRecord', () => {
  test('appends one JSON line per call under the space tagging dir', async (t) => {
    const root = await makeTempWorkspace(t);
    const { appendTaggingValidationRecord } = require('../tagging/validation-log');

    await appendTaggingValidationRecord({
      spaceId: 'space-1',
      threadKey: '__main__',
      messageId: 'msg-1',
      runId: 'run-1',
      pendingSliceSize: 2,
      toolCallAttempts: 1,
      tagResult: {
        messageTags: { isMentioned: true, configRequest: false },
        pendingThreadWindowDecision: { ready: true, reason: 'done' },
      },
      explicitRoot: root,
    });
    await appendTaggingValidationRecord({
      spaceId: 'space-1',
      threadKey: '__main__',
      messageId: 'msg-2',
      runId: 'run-2',
      pendingSliceSize: 3,
      tagResult: {
        messageTags: { isMentioned: false, configRequest: false },
        pendingThreadWindowDecision: { ready: false, reason: 'not yet' },
      },
      explicitRoot: root,
    });

    const raw = await fs.readFile(taggingValidationLogPath('space-1', root), 'utf8');
    const lines = raw.trim().split('\n').map((line) => JSON.parse(line));

    assert.equal(lines.length, 2);
    assert.equal(lines[0].messageId, 'msg-1');
    assert.equal(lines[0].toolCallAttempts, 1);
    assert.equal(lines[1].messageId, 'msg-2');
    assert.equal(lines[1].toolCallAttempts, null);
    assert.equal(lines[1].pendingThreadWindowDecision.ready, false);
  });
});

// ---------------------------------------------------------------------------
// Category: end-to-end thread window -> pending slice, sanity-checking the
// exact shape the tagging gate's prompt is built from (phase 1 integration).
// ---------------------------------------------------------------------------

describe('pending slice feeding the tagging gate', () => {
  test('a message appended to the thread window appears in its pending slice', async (t) => {
    const root = await makeTempWorkspace(t);
    const { getPendingSlice } = require('../context/threads-store');

    await appendMessageToThreadWindow({
      spaceId: 'space-1',
      explicitRoot: root,
      message: {
        id: 'msg-1',
        text: 'Please fix the failing login test',
        personEmail: 'dev@example.com',
        created: '2026-08-21T09:00:00.000Z',
      },
      botId: 'bot-1',
    });

    const slice = await getPendingSlice({
      spaceId: 'space-1',
      threadKey: '__main__',
      explicitRoot: root,
    });

    assert.equal(slice.length, 1);
    assert.equal(slice[0].content, 'Please fix the failing login test');
  });
});
