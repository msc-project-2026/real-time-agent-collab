'use strict';

const assert = require('node:assert/strict');
const { describe, test } = require('node:test');

const { loadWithMocks, makeLog, mockCalls } = require('./helpers.cjs');

// ---------------------------------------------------------------------------
// Category: v3 phase 5/6 message-flow orchestration.
// runMessageFlow wraps the tagging gate + deterministic dispatch + extract +
// respond as one managed Task Flow (flow-level tracking only, no runTask —
// see v3 migration memory). Phase 6 makes extract and respond independent
// steps that run together, not chained (see run-message-flow.js's own
// comment block for the concurrency design). These tests exercise its
// branching in isolation from the real Task Flow API, gate, extract, and
// respond steps — flow/keyed-lock.js itself is NOT mocked, so the locking
// behavior under test is real, not simulated.
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
    runExtractStep: t.mock.fn(async () => ({
      outcome: 'success',
      error: null,
      toolCalls: 0,
      sessionKey: 'agent:main:webex:space-1:extract:__main__',
      runId: 'extract-123',
    })),
    appendJobLogEntry: t.mock.fn(async () => undefined),
    ...overrides,
  };

  const loaded = loadWithMocks(require.resolve('../flow/run-message-flow'), {
    [require.resolve('../runtime')]: {
      getPluginRuntime: collaborators.getPluginRuntime,
      getRoutingAgentId: collaborators.getRoutingAgentId,
    },
    [require.resolve('../processing/gate/dispatch')]: {
      dispatchTaggingGate: collaborators.dispatchTaggingGate,
    },
    [require.resolve('../config/handle-request')]: {
      handleConfigRequest: collaborators.handleConfigRequest,
    },
    [require.resolve('../storage/threads-store')]: {
      getPendingSlice: collaborators.getPendingSlice,
      markThreadMessagesProcessing: collaborators.markThreadMessagesProcessing,
      finalizeProcessingMessages: collaborators.finalizeProcessingMessages,
      DEFAULT_PENDING_BACKSTOP_SIZE: 50,
    },
    [require.resolve('../processing/respond/dispatch')]: {
      runRespondStep: collaborators.runRespondStep,
    },
    [require.resolve('../processing/extract/dispatch')]: {
      runExtractStep: collaborators.runExtractStep,
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
  test('creates the flow, runs the gate, and finishes without config, extract, or respond', async (t) => {
    const { runMessageFlow, collaborators, boundFlow } = loadFlow(t);
    const finishSpy = t.mock.method(boundFlow, 'finish');

    await runMessageFlow(baseParams(t));

    assert.equal(collaborators.dispatchTaggingGate.mock.callCount(), 1);
    assert.equal(collaborators.handleConfigRequest.mock.callCount(), 0);
    assert.equal(collaborators.runExtractStep.mock.callCount(), 0);
    assert.equal(collaborators.runRespondStep.mock.callCount(), 0);
    assert.equal(finishSpy.mock.callCount(), 1);
    assert.equal(finishSpy.mock.calls[0].arguments[0].flowId, 'flow-1');
  });
});

describe('runMessageFlow — pending backstop (v3 §2)', () => {
  test('forces shouldProcess once pendingCount reaches the backstop size, even when the gate says neither addressed nor ready', async (t) => {
    const { runMessageFlow, collaborators } = loadFlow(t);

    await runMessageFlow(baseParams(t, { pendingCount: 50 }));

    assert.equal(collaborators.runExtractStep.mock.callCount(), 1);
    assert.equal(collaborators.runRespondStep.mock.callCount(), 1);
  });

  test('does not force shouldProcess below the backstop size', async (t) => {
    const { runMessageFlow, collaborators } = loadFlow(t);

    await runMessageFlow(baseParams(t, { pendingCount: 49 }));

    assert.equal(collaborators.runExtractStep.mock.callCount(), 0);
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
  test('hands off to the config flow and finishes without extract or respond', async (t) => {
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
    assert.equal(collaborators.runExtractStep.mock.callCount(), 0);
    assert.equal(collaborators.runRespondStep.mock.callCount(), 0);
    assert.equal(finishSpy.mock.callCount(), 1);
  });
});

describe('runMessageFlow — shouldProcess', () => {
  test('flushes pending, resumes into "process", runs extract and respond together, and finishes on success', async (t) => {
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
    // Finalize happens once, after both extract and respond have settled —
    // not immediately after the flush (see run-message-flow.js).
    assert.equal(collaborators.finalizeProcessingMessages.mock.callCount(), 1);
    assert.deepEqual(
      collaborators.finalizeProcessingMessages.mock.calls[0].arguments[0],
      expectedFlushArgs
    );
    assert.equal(resumeSpy.mock.callCount(), 1);
    assert.equal(resumeSpy.mock.calls[0].arguments[0].currentStep, 'process');
    assert.deepEqual(resumeSpy.mock.calls[0].arguments[0].stateJson.messageIds, ['message-1']);
    assert.equal(collaborators.runExtractStep.mock.callCount(), 1);
    assert.equal(collaborators.runRespondStep.mock.callCount(), 1);
    // Both steps must receive the flow's own claimed messageIds — this is
    // what lets each step filter its own batch out of the shared
    // `processing` array rather than seeing another flow's messages
    // (see processing/format-window.js).
    assert.deepEqual(collaborators.runExtractStep.mock.calls[0].arguments[0].messageIds, ['message-1']);
    assert.deepEqual(collaborators.runRespondStep.mock.calls[0].arguments[0].messageIds, ['message-1']);
    assert.equal(finishSpy.mock.callCount(), 1);
    assert.equal(finishSpy.mock.calls[0].arguments[0].stateJson.extractError, false);
    assert.equal(finishSpy.mock.calls[0].arguments[0].stateJson.respondError, false);
    assert.equal(
      collaborators.appendJobLogEntry.mock.calls.some(
        (call) => call.arguments[0].step === 'extract' && call.arguments[0].outcome === 'success'
      ),
      true
    );
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
    assert.equal(collaborators.runExtractStep.mock.callCount(), 1);
    assert.equal(collaborators.runRespondStep.mock.callCount(), 1);
  });

  test('a respond step failure does not block extract, does not fail the flow, and still finalizes ("maintain service")', async (t) => {
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

    assert.equal(collaborators.runExtractStep.mock.callCount(), 1);
    assert.equal(collaborators.finalizeProcessingMessages.mock.callCount(), 1);
    assert.equal(failSpy.mock.callCount(), 0);
    assert.equal(finishSpy.mock.callCount(), 1);
    assert.equal(finishSpy.mock.calls[0].arguments[0].stateJson.respondError, true);
    assert.equal(finishSpy.mock.calls[0].arguments[0].stateJson.extractError, false);
    assert.equal(
      collaborators.appendJobLogEntry.mock.calls.some(
        (call) => call.arguments[0].step === 'respond' && call.arguments[0].outcome === 'error'
      ),
      true
    );
  });

  test('an extract step failure does not block respond, does not fail the flow, and still finalizes ("maintain service")', async (t) => {
    const { runMessageFlow, collaborators, boundFlow } = loadFlow(t, {
      dispatchTaggingGate: (async () => ({
        messageTags: { isMentioned: true, configRequest: false },
        pendingThreadWindowDecision: { ready: false, reason: 'Addressed.' },
      })),
      runExtractStep: (async () => {
        throw new Error('write_task validation failed');
      }),
    });
    const finishSpy = t.mock.method(boundFlow, 'finish');
    const failSpy = t.mock.method(boundFlow, 'fail');

    await runMessageFlow(baseParams(t));

    assert.equal(collaborators.runRespondStep.mock.callCount(), 1);
    assert.equal(collaborators.finalizeProcessingMessages.mock.callCount(), 1);
    assert.equal(failSpy.mock.callCount(), 0);
    assert.equal(finishSpy.mock.callCount(), 1);
    assert.equal(finishSpy.mock.calls[0].arguments[0].stateJson.extractError, true);
    assert.equal(finishSpy.mock.calls[0].arguments[0].stateJson.respondError, false);
    assert.equal(
      collaborators.appendJobLogEntry.mock.calls.some(
        (call) => call.arguments[0].step === 'extract' && call.arguments[0].outcome === 'error'
      ),
      true
    );
  });

  test('extract and respond run together, not chained — respond is not delayed behind a slow extract', async (t) => {
    const order = [];
    let releaseExtract;
    const extractGate = new Promise((resolve) => {
      releaseExtract = resolve;
    });
    // Safety net: if an assertion below throws before the manual release,
    // this still unblocks runExtractStep so the flow can settle and the
    // test runner doesn't hang on a permanently-pending promise.
    t.after(() => releaseExtract());

    const { runMessageFlow } = loadFlow(t, {
      dispatchTaggingGate: (async () => ({
        messageTags: { isMentioned: true, configRequest: false },
        pendingThreadWindowDecision: { ready: false, reason: 'Addressed.' },
      })),
      runExtractStep: (async () => {
        order.push('extract-start');
        await extractGate;
        order.push('extract-end');
        return { outcome: 'success', error: null, toolCalls: 0 };
      }),
      runRespondStep: (async () => {
        order.push('respond-start');
        order.push('respond-end');
        return { outcome: 'success', error: null, toolCalls: 0, didSend: true };
      }),
    });

    const flowPromise = runMessageFlow(baseParams(t));

    // Give respond a chance to run to completion while extract is still
    // deliberately blocked — proves it isn't waiting on extract. Not
    // asserting which one's *start* is logged first: runExtractStep is
    // wrapped in withLock, which defers the call by one extra microtask
    // tick versus respond's direct call, so that ordering isn't guaranteed
    // or meaningful — what matters is respond completing while extract is
    // demonstrably still blocked.
    await new Promise((resolve) => setTimeout(resolve, 5));
    assert.ok(order.includes('respond-end'), 'respond should have completed');
    assert.ok(!order.includes('extract-end'), 'extract should still be blocked');

    releaseExtract();
    await flowPromise;
    assert.ok(order.includes('extract-end'), 'extract should complete once released');
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
    assert.equal(collaborators.runExtractStep.mock.callCount(), 1);
    assert.equal(collaborators.runRespondStep.mock.callCount(), 1);
  });
});

describe('runMessageFlow — concurrency locking', () => {
  test('layer 2a: two messages on the same thread gate+flush strictly one after another', async (t) => {
    const order = [];
    let releaseFirstGate;
    const firstGate = new Promise((resolve) => {
      releaseFirstGate = resolve;
    });
    // Safety net — see the "extract and respond run together" test above for
    // why this matters (an assertion throwing before the manual release
    // would otherwise hang the runner on a permanently-pending promise).
    t.after(() => releaseFirstGate());

    let callIndex = 0;
    const { runMessageFlow } = loadFlow(t, {
      dispatchTaggingGate: t.mock.fn(async () => {
        const isFirst = callIndex === 0;
        callIndex += 1;
        order.push(isFirst ? 'first-gate-start' : 'second-gate-start');
        if (isFirst) {
          await firstGate;
        }
        order.push(isFirst ? 'first-gate-end' : 'second-gate-end');
        return {
          messageTags: { isMentioned: false, configRequest: false },
          pendingThreadWindowDecision: { ready: false, reason: 'Not ready.' },
        };
      }),
    });

    const firstFlow = runMessageFlow(baseParams(t, { message: { id: 'message-1', mentionedPeople: [] } }));
    const secondFlow = runMessageFlow(baseParams(t, { message: { id: 'message-2', mentionedPeople: [] } }));

    await new Promise((resolve) => setTimeout(resolve, 5));
    // The second message's gate must not have started — still queued behind
    // the first message's gate+flush lock for the same thread.
    assert.deepEqual(order, ['first-gate-start']);

    releaseFirstGate();
    await Promise.all([firstFlow, secondFlow]);
    assert.deepEqual(order, [
      'first-gate-start',
      'first-gate-end',
      'second-gate-start',
      'second-gate-end',
    ]);
  });

  test('layer 2b: two extract runs in the same space (different threads) still serialize', async (t) => {
    const order = [];
    let releaseFirstExtract;
    const firstExtract = new Promise((resolve) => {
      releaseFirstExtract = resolve;
    });
    t.after(() => releaseFirstExtract());

    let callIndex = 0;
    const { runMessageFlow } = loadFlow(t, {
      dispatchTaggingGate: (async () => ({
        messageTags: { isMentioned: true, configRequest: false },
        pendingThreadWindowDecision: { ready: false, reason: 'Addressed.' },
      })),
      runExtractStep: t.mock.fn(async () => {
        const isFirst = callIndex === 0;
        callIndex += 1;
        order.push(isFirst ? 'first-extract-start' : 'second-extract-start');
        if (isFirst) {
          await firstExtract;
        }
        order.push(isFirst ? 'first-extract-end' : 'second-extract-end');
        return { outcome: 'success', error: null, toolCalls: 0 };
      }),
    });

    const firstFlow = runMessageFlow(
      baseParams(t, { threadKey: 'thread-a', message: { id: 'message-1', mentionedPeople: [] } })
    );
    const secondFlow = runMessageFlow(
      baseParams(t, { threadKey: 'thread-b', message: { id: 'message-2', mentionedPeople: [] } })
    );

    await new Promise((resolve) => setTimeout(resolve, 5));
    // Different threads, same space — the second extract must still be
    // queued behind the first (layer 2b is per-space, not per-thread).
    assert.deepEqual(order, ['first-extract-start']);

    releaseFirstExtract();
    await Promise.all([firstFlow, secondFlow]);
    assert.deepEqual(order, [
      'first-extract-start',
      'first-extract-end',
      'second-extract-start',
      'second-extract-end',
    ]);
  });
});

describe('runMessageFlow — Task Flow unavailable', () => {
  test('still runs the gate, extract, and respond when tasks.flow is missing, never throws', async (t) => {
    const { runMessageFlow, collaborators } = loadFlow(t, {
      getPluginRuntime: (() => ({})),
      dispatchTaggingGate: (async () => ({
        messageTags: { isMentioned: true, configRequest: false },
        pendingThreadWindowDecision: { ready: false, reason: 'Addressed.' },
      })),
    });

    await assert.doesNotReject(runMessageFlow(baseParams(t)));

    assert.equal(collaborators.runExtractStep.mock.callCount(), 1);
    assert.equal(collaborators.runRespondStep.mock.callCount(), 1);
  });
});
