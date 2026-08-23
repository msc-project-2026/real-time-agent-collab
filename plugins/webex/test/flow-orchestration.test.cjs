'use strict';

const assert = require('node:assert/strict');
const { describe, test } = require('node:test');

const { loadWithMocks, makeLog, mockCalls } = require('./helpers.cjs');

// ---------------------------------------------------------------------------
// Category: v3 phase 5 message-flow orchestration.
// runMessageFlow wraps the tagging gate + deterministic dispatch + respond
// step as one managed Task Flow (flow-level tracking only, no runTask — see
// v3 migration memory). These tests exercise its branching in isolation from
// the real Task Flow API, gate, and respond step.
// ---------------------------------------------------------------------------

function makeBoundFlow(overrides = {}) {
  let revision = 0;

  return {
    createManaged: (params) => {
      revision = 0;
      return { flowId: 'flow-1', revision, status: 'queued', ...params };
    },
    resume: (params) => {
      revision += 1;
      return { applied: true, flow: { flowId: params.flowId, revision, status: 'running' } };
    },
    finish: (params) => {
      revision += 1;
      return { applied: true, flow: { flowId: params.flowId, revision, status: 'succeeded' } };
    },
    fail: (params) => {
      revision += 1;
      return { applied: true, flow: { flowId: params.flowId, revision, status: 'failed' } };
    },
    ...overrides,
  };
}

function loadFlow(t, overrides = {}) {
  const boundFlow = overrides.boundFlow ?? makeBoundFlow();

  const collaborators = {
    getPluginRuntime: t.mock.fn(() => ({
      tasks: { flow: { bindSession: t.mock.fn(() => boundFlow) } },
    })),
    getRoutingAgentId: t.mock.fn(() => 'main'),
    dispatchTaggingGate: t.mock.fn(async () => ({
      messageTags: { isMentioned: false, configRequest: false },
      pendingThreadWindowDecision: { ready: false, reason: 'Not yet.' },
    })),
    handleConfigRequest: t.mock.fn(async () => undefined),
    getPendingSlice: t.mock.fn(async () => [{ id: 'message-1' }]),
    markThreadMessagesProcessing: t.mock.fn(async () => undefined),
    finalizeProcessingMessages: t.mock.fn(async () => undefined),
    runRespondStep: t.mock.fn(async () => ({
      outcome: 'success',
      error: null,
      toolCalls: 0,
      sessionKey: 'agent:main:webex:space-1:respond:__main__',
      runId: 'respond-123',
      didSend: false,
    })),
    appendJobLogEntry: t.mock.fn(async () => undefined),
    ...overrides,
  };

  const loaded = loadWithMocks(require.resolve('../flow/run-message-flow'), {
    [require.resolve('../runtime')]: {
      getPluginRuntime: collaborators.getPluginRuntime,
      getRoutingAgentId: collaborators.getRoutingAgentId,
    },
    [require.resolve('../tagging/dispatch')]: {
      dispatchTaggingGate: collaborators.dispatchTaggingGate,
    },
    [require.resolve('../config/handle-request')]: {
      handleConfigRequest: collaborators.handleConfigRequest,
    },
    [require.resolve('../context/threads-store')]: {
      getPendingSlice: collaborators.getPendingSlice,
      markThreadMessagesProcessing: collaborators.markThreadMessagesProcessing,
      finalizeProcessingMessages: collaborators.finalizeProcessingMessages,
      DEFAULT_PENDING_BACKSTOP_SIZE: 50,
    },
    [require.resolve('../processing/respond')]: {
      runRespondStep: collaborators.runRespondStep,
    },
    [require.resolve('../flow/job-log')]: {
      appendJobLogEntry: collaborators.appendJobLogEntry,
    },
  });
  t.after(loaded.restore);

  return { ...loaded.subject, collaborators, boundFlow };
}

function baseParams(t, overrides = {}) {
  return {
    spaceId: 'space-1',
    threadKey: '__main__',
    message: { id: 'message-1', mentionedPeople: [] },
    botId: 'bot-1',
    pendingCount: 1,
    account: { accountId: 'default' },
    log: makeLog(t),
    sendFn: undefined,
    ...overrides,
  };
}

describe('runMessageFlow — nothing warranted', () => {
  test('creates the flow, runs the gate, and finishes without config or respond', async (t) => {
    const { runMessageFlow, collaborators, boundFlow } = loadFlow(t);
    const finishSpy = t.mock.method(boundFlow, 'finish');

    await runMessageFlow(baseParams(t));

    assert.equal(collaborators.dispatchTaggingGate.mock.callCount(), 1);
    assert.equal(collaborators.handleConfigRequest.mock.callCount(), 0);
    assert.equal(collaborators.runRespondStep.mock.callCount(), 0);
    assert.equal(finishSpy.mock.callCount(), 1);
    assert.equal(finishSpy.mock.calls[0].arguments[0].flowId, 'flow-1');
  });
});

describe('runMessageFlow — pending backstop (v3 §2)', () => {
  test('forces shouldProcess once pendingCount reaches the backstop size, even when the gate says neither addressed nor ready', async (t) => {
    const { runMessageFlow, collaborators } = loadFlow(t);

    await runMessageFlow(baseParams(t, { pendingCount: 50 }));

    assert.equal(collaborators.runRespondStep.mock.callCount(), 1);
  });

  test('does not force shouldProcess below the backstop size', async (t) => {
    const { runMessageFlow, collaborators } = loadFlow(t);

    await runMessageFlow(baseParams(t, { pendingCount: 49 }));

    assert.equal(collaborators.runRespondStep.mock.callCount(), 0);
  });

  test('logs backstopTriggered on the dispatch-decision line', async (t) => {
    const { runMessageFlow, collaborators } = loadFlow(t);
    const log = makeLog(t);

    await runMessageFlow(baseParams(t, { pendingCount: 62, log }));

    const decisionLine = mockCalls(log.info).find(([text]) =>
      text.includes('dispatch decision')
    );
    const payload = JSON.parse(decisionLine[0].slice(decisionLine[0].indexOf('{')));
    assert.equal(payload.backstopTriggered, true);
    assert.equal(payload.pendingCount, 62);
    assert.equal(payload.shouldProcess, true);
  });
});

describe('runMessageFlow — configRequest', () => {
  test('hands off to the config flow and finishes without respond', async (t) => {
    const { runMessageFlow, collaborators, boundFlow } = loadFlow(t, {
      dispatchTaggingGate: (async () => ({
        messageTags: { isMentioned: false, configRequest: true },
        pendingThreadWindowDecision: { ready: false, reason: 'Config ask only.' },
      })),
    });
    const finishSpy = t.mock.method(boundFlow, 'finish');

    await runMessageFlow(baseParams(t));

    assert.equal(collaborators.handleConfigRequest.mock.callCount(), 1);
    assert.equal(collaborators.handleConfigRequest.mock.calls[0].arguments[0].spaceId, 'space-1');
    assert.equal(collaborators.runRespondStep.mock.callCount(), 0);
    assert.equal(finishSpy.mock.callCount(), 1);
  });
});

describe('runMessageFlow — shouldProcess', () => {
  test('flushes pending, resumes into respond, and finishes on success', async (t) => {
    const { runMessageFlow, collaborators, boundFlow } = loadFlow(t, {
      dispatchTaggingGate: (async () => ({
        messageTags: { isMentioned: true, configRequest: false },
        pendingThreadWindowDecision: { ready: false, reason: 'Addressed.' },
      })),
    });
    const resumeSpy = t.mock.method(boundFlow, 'resume');
    const finishSpy = t.mock.method(boundFlow, 'finish');

    await runMessageFlow(baseParams(t));

    const expectedFlushArgs = {
      spaceId: 'space-1',
      threadKey: '__main__',
      messageIds: ['message-1'],
    };
    assert.equal(collaborators.markThreadMessagesProcessing.mock.callCount(), 1);
    assert.deepEqual(
      collaborators.markThreadMessagesProcessing.mock.calls[0].arguments[0],
      expectedFlushArgs
    );
    // Temporary bridge (see run-message-flow.js) — flush is immediately
    // followed by finalize until the real gate+flush lock and extract step
    // land; both get the same messageIds.
    assert.equal(collaborators.finalizeProcessingMessages.mock.callCount(), 1);
    assert.deepEqual(
      collaborators.finalizeProcessingMessages.mock.calls[0].arguments[0],
      expectedFlushArgs
    );
    assert.equal(resumeSpy.mock.callCount(), 1);
    assert.equal(resumeSpy.mock.calls[0].arguments[0].currentStep, 'respond');
    assert.equal(collaborators.runRespondStep.mock.callCount(), 1);
    assert.equal(finishSpy.mock.callCount(), 1);
    assert.equal(
      collaborators.appendJobLogEntry.mock.calls.some(
        (call) => call.arguments[0].step === 'respond' && call.arguments[0].outcome === 'success'
      ),
      true
    );
  });

  test('skips markThreadMessagesProcessing/finalizeProcessingMessages when the pending slice is empty', async (t) => {
    const { runMessageFlow, collaborators } = loadFlow(t, {
      dispatchTaggingGate: (async () => ({
        messageTags: { isMentioned: true, configRequest: false },
        pendingThreadWindowDecision: { ready: false, reason: 'Addressed.' },
      })),
      getPendingSlice: (async () => []),
    });

    await runMessageFlow(baseParams(t));

    assert.equal(collaborators.markThreadMessagesProcessing.mock.callCount(), 0);
    assert.equal(collaborators.finalizeProcessingMessages.mock.callCount(), 0);
    assert.equal(collaborators.runRespondStep.mock.callCount(), 1);
  });

  test('a respond step failure fails the flow instead of finishing it', async (t) => {
    const { runMessageFlow, collaborators, boundFlow } = loadFlow(t, {
      dispatchTaggingGate: (async () => ({
        messageTags: { isMentioned: true, configRequest: false },
        pendingThreadWindowDecision: { ready: false, reason: 'Addressed.' },
      })),
      runRespondStep: (async () => {
        throw new Error('spawn timed out');
      }),
    });
    const finishSpy = t.mock.method(boundFlow, 'finish');
    const failSpy = t.mock.method(boundFlow, 'fail');

    await runMessageFlow(baseParams(t));

    assert.equal(finishSpy.mock.callCount(), 0);
    assert.equal(failSpy.mock.callCount(), 1);
    assert.match(failSpy.mock.calls[0].arguments[0].blockedSummary, /spawn timed out/);
    assert.equal(
      collaborators.appendJobLogEntry.mock.calls.some(
        (call) => call.arguments[0].step === 'respond' && call.arguments[0].outcome === 'error'
      ),
      true
    );
  });

  test('configRequest and shouldProcess both fire when the gate reports both', async (t) => {
    const { runMessageFlow, collaborators } = loadFlow(t, {
      dispatchTaggingGate: (async () => ({
        messageTags: { isMentioned: true, configRequest: true },
        pendingThreadWindowDecision: { ready: false, reason: 'Both.' },
      })),
    });

    await runMessageFlow(baseParams(t));

    assert.equal(collaborators.handleConfigRequest.mock.callCount(), 1);
    assert.equal(collaborators.runRespondStep.mock.callCount(), 1);
  });
});

describe('runMessageFlow — Task Flow unavailable', () => {
  test('still runs the gate and respond when tasks.flow is missing, never throws', async (t) => {
    const { runMessageFlow, collaborators } = loadFlow(t, {
      getPluginRuntime: (() => ({})),
      dispatchTaggingGate: (async () => ({
        messageTags: { isMentioned: true, configRequest: false },
        pendingThreadWindowDecision: { ready: false, reason: 'Addressed.' },
      })),
    });

    await assert.doesNotReject(runMessageFlow(baseParams(t)));

    assert.equal(collaborators.runRespondStep.mock.callCount(), 1);
  });
});
