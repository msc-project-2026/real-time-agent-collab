'use strict';

const assert = require('node:assert/strict');
const { describe, test } = require('node:test');

const { loadWithMocks, makeLog, mockCalls } = require('./helpers.cjs');

// ---------------------------------------------------------------------------
// Category: route_message tool validation.
// The tool is the contract boundary; invalid inputs return structured errors
// so the model can retry without the gateway throwing.
// ---------------------------------------------------------------------------

describe('route_message tool validation', () => {
  // Reload the tool fresh each test so pendingRouteResults state doesn't leak.
  function loadTool() {
    const resolved = require.resolve('../routing/tool');
    delete require.cache[resolved];
    return require(resolved);
  }

  test('empty routes array stores result and returns ok', async () => {
    const { routeMessageTool, takePendingRouteResult } = loadTool();
    const tool = routeMessageTool();

    const result = await tool.execute('id-1', { spaceId: 'space-1', routes: [] });

    assert.deepEqual(result, { ok: true, routeCount: 0, chosenRoutes: [] });
    assert.deepEqual(takePendingRouteResult('space-1'), { routes: [] });
  });

  test('single valid recall_request route stores result', async () => {
    const { routeMessageTool, takePendingRouteResult } = loadTool();
    const tool = routeMessageTool();

    const result = await tool.execute('id-2', {
      spaceId: 'space-1',
      routes: [{ route: 'recall_request', reason: 'Asking about prior decisions' }],
    });

    assert.deepEqual(result, { ok: true, routeCount: 1, chosenRoutes: ['recall_request'] });
    assert.deepEqual(takePendingRouteResult('space-1'), {
      routes: [{ route: 'recall_request', reason: 'Asking about prior decisions' }],
    });
  });

  test('multiple valid routes stores result', async () => {
    const { routeMessageTool, takePendingRouteResult } = loadTool();
    const tool = routeMessageTool();

    const result = await tool.execute('id-3', {
      spaceId: 'space-1',
      routes: [
        { route: 'recall_request', reason: 'Status check' },
        { route: 'task_request', reason: 'Add a feature' },
      ],
    });

    assert.deepEqual(result, { ok: true, routeCount: 2, chosenRoutes: ['recall_request', 'task_request'] });
    const stored = takePendingRouteResult('space-1');
    assert.equal(stored.routes.length, 2);
  });

  test('duplicate route value returns validation error and does not store', async () => {
    const { routeMessageTool, takePendingRouteResult } = loadTool();
    const tool = routeMessageTool();

    const result = await tool.execute('id-4', {
      spaceId: 'space-1',
      routes: [
        { route: 'recall_request', reason: 'First' },
        { route: 'recall_request', reason: 'Second' },
      ],
    });

    assert.equal(result.ok, false);
    assert.ok(Array.isArray(result.errors));
    assert.ok(result.errors.some((e) => e.includes('duplicated')));
    assert.equal(takePendingRouteResult('space-1'), null);
  });

  test('unknown route value returns validation error and does not store', async () => {
    const { routeMessageTool, takePendingRouteResult } = loadTool();
    const tool = routeMessageTool();

    const result = await tool.execute('id-5', {
      spaceId: 'space-1',
      routes: [{ route: 'unsupported_route', reason: 'Testing' }],
    });

    assert.equal(result.ok, false);
    assert.ok(Array.isArray(result.errors));
    assert.ok(result.errors.some((e) => e.includes('not a valid route value')));
    assert.equal(takePendingRouteResult('space-1'), null);
  });

  test('empty reason string returns validation error and does not store', async () => {
    const { routeMessageTool, takePendingRouteResult } = loadTool();
    const tool = routeMessageTool();

    const result = await tool.execute('id-6', {
      spaceId: 'space-1',
      routes: [{ route: 'task_request', reason: '   ' }],
    });

    assert.equal(result.ok, false);
    assert.ok(Array.isArray(result.errors));
    assert.ok(result.errors.some((e) => e.includes('reason')));
    assert.equal(takePendingRouteResult('space-1'), null);
  });

  test('missing spaceId returns error without storing', async () => {
    const { routeMessageTool, takePendingRouteResult } = loadTool();
    const tool = routeMessageTool();

    const result = await tool.execute('id-7', { spaceId: '', routes: [] });

    assert.equal(result.ok, false);
    assert.ok(result.error);
  });

  test('missing routes array returns error without storing', async () => {
    const { routeMessageTool, takePendingRouteResult } = loadTool();
    const tool = routeMessageTool();

    const result = await tool.execute('id-8', { spaceId: 'space-1' });

    assert.equal(result.ok, false);
    assert.ok(result.error);
    assert.equal(takePendingRouteResult('space-1'), null);
  });

  test('takePendingRouteResult clears the entry after reading', async () => {
    const { routeMessageTool, takePendingRouteResult } = loadTool();
    const tool = routeMessageTool();

    await tool.execute('id-9', { spaceId: 'space-1', routes: [] });

    const first = takePendingRouteResult('space-1');
    const second = takePendingRouteResult('space-1');

    assert.deepEqual(first, { routes: [] });
    assert.equal(second, null);
  });
});

// ---------------------------------------------------------------------------
// Category: handleRoutingDispatchResult — post-dispatch result consumption.
// ---------------------------------------------------------------------------

function loadResultHandler(t) {
  const collaborators = {
    appendPendingMessage: t.mock.fn(async () => ({ ok: true })),
    schedulePendingBatchStaging: t.mock.fn(),
    handleStagePendingBatchRequest: t.mock.fn(async () => ({ ok: true })),
    handleConfigRequest: t.mock.fn(async () => undefined),
    handleRecallRequest: t.mock.fn(async () => undefined),
  };

  // Reload tool module fresh so state is isolated
  const toolResolved = require.resolve('../routing/tool');
  const savedTool = require.cache[toolResolved];
  delete require.cache[toolResolved];
  const freshTool = require(toolResolved);

  const loaded = loadWithMocks(require.resolve('../routing/result-handler'), {
    [require.resolve('../batch/append')]: {
      appendPendingMessage: collaborators.appendPendingMessage,
    },
    [require.resolve('../batch/schedule')]: {
      schedulePendingBatchStaging: collaborators.schedulePendingBatchStaging,
    },
    [require.resolve('../batch/staging-handler')]: {
      handleStagePendingBatchRequest: collaborators.handleStagePendingBatchRequest,
    },
    [require.resolve('../config/handle-request')]: {
      handleConfigRequest: collaborators.handleConfigRequest,
    },
    [require.resolve('../recall/handle-request')]: {
      handleRecallRequest: collaborators.handleRecallRequest,
    },
    [require.resolve('../routing/tool')]: freshTool,
  });

  t.after(() => {
    loaded.restore();
    if (savedTool) require.cache[toolResolved] = savedTool;
    else delete require.cache[toolResolved];
  });

  return { ...loaded.subject, collaborators, tool: freshTool };
}

function routeContext(t) {
  return {
    spaceId: 'space-1',
    message: { id: 'message-1', roomId: 'space-1', text: 'Please help' },
    account: { accountId: 'default', config: { token: 'bot-token' } },
    log: makeLog(t),
  };
}

describe('handleRoutingDispatchResult — downstream behaviour', () => {
  test('appends and schedules when tool deposits empty routes', async (t) => {
    const { handleRoutingDispatchResult, collaborators, tool } = loadResultHandler(t);
    const ctx = routeContext(t);

    tool.setPendingRouteResult('space-1', { routes: [] });
    await handleRoutingDispatchResult(ctx);

    assert.equal(collaborators.appendPendingMessage.mock.callCount(), 1);
    assert.deepEqual(
      collaborators.appendPendingMessage.mock.calls[0].arguments[0],
      { spaceId: 'space-1', message: ctx.message }
    );
    assert.equal(collaborators.schedulePendingBatchStaging.mock.callCount(), 1);
    assert.equal(collaborators.handleStagePendingBatchRequest.mock.callCount(), 0);
  });

  test('runs config, recall, and immediate task staging in declared order', async (t) => {
    const { handleRoutingDispatchResult, collaborators, tool } = loadResultHandler(t);
    const ctx = routeContext(t);

    tool.setPendingRouteResult('space-1', {
      routes: [
        { route: 'config_request', reason: 'User asked for settings' },
        { route: 'recall_request', reason: 'User asked about state' },
        { route: 'task_request', reason: 'User requested a task' },
      ],
    });
    await handleRoutingDispatchResult(ctx);

    assert.equal(collaborators.appendPendingMessage.mock.callCount(), 1);
    assert.equal(collaborators.handleConfigRequest.mock.callCount(), 1);
    assert.deepEqual(collaborators.handleConfigRequest.mock.calls[0].arguments[0], {
      spaceId: 'space-1',
      account: ctx.account,
      log: ctx.log,
      sendFn: undefined,
    });
    assert.equal(collaborators.handleRecallRequest.mock.callCount(), 1);
    assert.equal(collaborators.handleStagePendingBatchRequest.mock.callCount(), 1);
    assert.equal(collaborators.schedulePendingBatchStaging.mock.callCount(), 0);
  });

  test('falls back to append-only and logs error when no tool call was made (free-text path)', async (t) => {
    const { handleRoutingDispatchResult, collaborators } = loadResultHandler(t);
    const ctx = routeContext(t);

    // No tool.setPendingRouteResult — simulates model answering in text instead of calling tool
    await handleRoutingDispatchResult(ctx);

    assert.equal(ctx.log.error.mock.callCount(), 1);
    assert.ok(
      mockCalls(ctx.log.error)[0][0].includes('did not call route_message')
    );
    assert.equal(collaborators.appendPendingMessage.mock.callCount(), 1);
    assert.equal(collaborators.schedulePendingBatchStaging.mock.callCount(), 1);
    assert.equal(collaborators.handleStagePendingBatchRequest.mock.callCount(), 0);
  });

  test('warns about duplicate and unknown routes without running them', async (t) => {
    const { handleRoutingDispatchResult, collaborators, tool } = loadResultHandler(t);
    const ctx = routeContext(t);

    // Bypass tool validation by seeding directly — tests handleRouteResult defensive check
    tool.setPendingRouteResult('space-1', {
      routes: [
        { route: 'recall_request', reason: 'State' },
        { route: 'recall_request', reason: 'Duplicate' },
        { route: 'unsupported', reason: 'Unknown' },
      ],
    });
    await handleRoutingDispatchResult(ctx);

    assert.equal(ctx.log.warn.mock.callCount(), 2); // duplicate + unknown
    assert.equal(collaborators.handleRecallRequest.mock.callCount(), 1);
    assert.equal(collaborators.schedulePendingBatchStaging.mock.callCount(), 1);
  });

  test('logs and rethrows a downstream append failure', async (t) => {
    const { handleRoutingDispatchResult, collaborators, tool } = loadResultHandler(t);
    const ctx = routeContext(t);
    collaborators.appendPendingMessage.mock.mockImplementationOnce(async () => {
      throw new Error('disk unavailable');
    });

    tool.setPendingRouteResult('space-1', { routes: [] });

    await assert.rejects(
      handleRoutingDispatchResult(ctx),
      /disk unavailable/
    );
    assert.equal(ctx.log.error.mock.callCount(), 1);
  });
});

// ---------------------------------------------------------------------------
// Category: Webhook identity dispatch.
// These tests verify OAuth message events and bot attachment actions go to
// separate handlers while unrelated payloads are ignored.
// ---------------------------------------------------------------------------

describe('inbound webhook identity dispatch', () => {
  test('routes only the supported identity/resource combinations', async (t) => {
    const handleInboundWebexMessage = t.mock.fn(async () => 'message-result');
    const handleInboundWebexAttachmentAction = t.mock.fn(async () => 'action-result');
    const loaded = loadWithMocks(require.resolve('../inbound/index'), {
      [require.resolve('../inbound/message')]: { handleInboundWebexMessage },
      [require.resolve('../inbound/attachment-actions')]: {
        handleInboundWebexAttachmentAction,
      },
    });
    t.after(loaded.restore);
    const ctx = { account: { accountId: 'default' }, log: makeLog(t) };

    const messageResult = await loaded.subject.handleInboundWebexWebhook(
      { resource: 'messages', event: 'created', data: { id: 'message-1' } },
      { ...ctx, identity: 'oauth' }
    );
    const actionResult = await loaded.subject.handleInboundWebexWebhook(
      { resource: 'attachmentActions', event: 'created', data: { id: 'action-1' } },
      { ...ctx, identity: 'bot' }
    );
    const ignored = await loaded.subject.handleInboundWebexWebhook(
      { resource: 'messages', event: 'deleted' },
      { ...ctx, identity: 'oauth' }
    );

    assert.equal(messageResult, 'message-result');
    assert.equal(actionResult, 'action-result');
    assert.equal(ignored, undefined);
    assert.equal(handleInboundWebexMessage.mock.callCount(), 1);
    assert.equal(handleInboundWebexAttachmentAction.mock.callCount(), 1);
  });
});

// ---------------------------------------------------------------------------
// Helpers for inbound/message tests
// ---------------------------------------------------------------------------

function loadMessageHandler(t, overrides = {}) {
  const defaultMessage = {
    id: 'message-1',
    roomId: 'space-1',
    roomType: 'group',
    personId: 'person-1',
    personEmail: 'person@example.com',
    text: 'Please check the release',
  };
  const collaborators = {
    webexFetch: t.mock.fn(async (_token, apiPath) =>
      apiPath.startsWith('/messages/')
        ? { ...defaultMessage }
        : { items: [{ id: 'membership-1' }] }
    ),
    getAccessToken: t.mock.fn(() => 'oauth-token'),
    appendMessageToThreadWindow: t.mock.fn(async () => ({
      threadKey: '__main__',
    })),
    getPendingSlice: t.mock.fn(async () => []),
    markThreadMessagesProcessed: t.mock.fn(async () => undefined),
    appendPendingMessage: t.mock.fn(async () => ({ ok: true })),
    handleStagePendingBatchRequest: t.mock.fn(async () => ({ ok: true })),
    handleConfigRequest: t.mock.fn(async () => undefined),
    // Default: gate produces a result that never triggers dispatch on its own —
    // individual tests override this to exercise configRequest/mention/ready.
    dispatchTaggingGate: t.mock.fn(async () => ({
      messageTags: { isMentioned: false, configRequest: false },
      pendingThreadWindowDecision: { ready: false, reason: 'Not yet.' },
    })),
    getPluginRuntime: t.mock.fn(() => ({ runtime: true })),
    ...overrides,
  };

  const loaded = loadWithMocks(require.resolve('../inbound/message'), {
    [require.resolve('../api')]: { webexFetch: collaborators.webexFetch },
    [require.resolve('../token')]: { getAccessToken: collaborators.getAccessToken },
    [require.resolve('../context/threads-store')]: {
      appendMessageToThreadWindow:
        collaborators.appendMessageToThreadWindow,
      getPendingSlice: collaborators.getPendingSlice,
      markThreadMessagesProcessed: collaborators.markThreadMessagesProcessed,
    },
    [require.resolve('../batch/append')]: {
      appendPendingMessage: collaborators.appendPendingMessage,
    },
    [require.resolve('../batch/staging-handler')]: {
      handleStagePendingBatchRequest: collaborators.handleStagePendingBatchRequest,
    },
    [require.resolve('../config/handle-request')]: {
      handleConfigRequest: collaborators.handleConfigRequest,
    },
    [require.resolve('../tagging/dispatch')]: {
      dispatchTaggingGate: collaborators.dispatchTaggingGate,
    },
    [require.resolve('../runtime')]: {
      getPluginRuntime: collaborators.getPluginRuntime,
    },
  });
  t.after(loaded.restore);

  return { ...loaded.subject, collaborators };
}

function inboundContext(t, overrides = {}) {
  return {
    botId: 'bot-1',
    cfg: { token: 'bot-token', dmPolicy: 'deny', allowFrom: [] },
    account: { accountId: 'default' },
    log: makeLog(t),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Category: Direct-message policy.
// ---------------------------------------------------------------------------

describe('direct-message policy', () => {
  test('supports allow, deny, allowlisted IDs/emails, and safe defaults', () => {
    const { isDmAllowed } = require('../inbound/message');

    assert.equal(isDmAllowed({ dmPolicy: 'allow' }, 'p1', 'p@example.com'), true);
    assert.equal(isDmAllowed({ dmPolicy: 'deny' }, 'p1', 'p@example.com'), false);
    assert.equal(
      isDmAllowed({ dmPolicy: 'allowlisted', allowFrom: ['p1'] }, 'p1', 'p@example.com'),
      true
    );
    assert.equal(
      isDmAllowed(
        { dmPolicy: 'allowlisted', allowFrom: ['p@example.com'] },
        'p1',
        'p@example.com'
      ),
      true
    );
    assert.equal(isDmAllowed({ dmPolicy: 'unknown' }, 'p1', 'p@example.com'), false);
  });
});

// ---------------------------------------------------------------------------
// Category: Early inbound rejection.
// ---------------------------------------------------------------------------

describe('early inbound rejection', () => {
  test('ignores non-created message events before reading credentials', async (t) => {
    const { handleInboundWebexMessage, collaborators } = loadMessageHandler(t);
    await handleInboundWebexMessage(
      { resource: 'messages', event: 'deleted', data: { id: 'message-irrelevant' } },
      inboundContext(t)
    );
    assert.equal(collaborators.getAccessToken.mock.callCount(), 0);
  });

  test('rejects a created message when neither OAuth nor bot token is available', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const { handleInboundWebexMessage } = loadMessageHandler(t, {
      getAccessToken: t.mock.fn(() => null),
    });
    await assert.rejects(
      handleInboundWebexMessage(
        { resource: 'messages', event: 'created', data: { id: 'message-no-token' } },
        inboundContext(t, { cfg: { token: '', dmPolicy: 'deny' } })
      ),
      /Webex token is required/
    );
  });

  test('deduplicates repeated deliveries before the Webex API call', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const { handleInboundWebexMessage, collaborators } = loadMessageHandler(t);
    const payload = {
      resource: 'messages',
      event: 'created',
      data: { id: 'message-duplicate' },
    };
    const context = inboundContext(t);

    await handleInboundWebexMessage(payload, context);
    await handleInboundWebexMessage(payload, context);

    assert.equal(collaborators.webexFetch.mock.callCount(), 2);
    assert.ok(mockCalls(context.log.info).some(([text]) => text.includes('duplicate')));
  });

  test('drops a denied direct message before membership and storage', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const webexFetch = t.mock.fn(async () => ({
      id: 'message-dm-denied',
      roomId: 'space-1',
      roomType: 'direct',
      personId: 'person-1',
      personEmail: 'person@example.com',
    }));
    const { handleInboundWebexMessage, collaborators } = loadMessageHandler(t, {
      webexFetch,
    });

    await handleInboundWebexMessage(
      { resource: 'messages', event: 'created', data: { id: 'message-dm-denied' } },
      inboundContext(t)
    );

    assert.equal(webexFetch.mock.callCount(), 1);
    assert.equal(collaborators.appendMessageToThreadWindow.mock.callCount(), 0);
  });

  test('drops messages when membership lookup fails or returns no membership', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    let lookup = 0;
    const webexFetch = t.mock.fn(async (_token, apiPath) => {
      if (apiPath.startsWith('/messages/')) {
        return {
          id: `message-membership-${lookup}`,
          roomId: 'space-1',
          roomType: 'group',
          personId: 'person-1',
        };
      }
      lookup += 1;
      if (lookup === 1) throw new Error('forbidden');
      return { items: [] };
    });
    const { handleInboundWebexMessage, collaborators } = loadMessageHandler(t, {
      webexFetch,
    });
    const context = inboundContext(t);

    await handleInboundWebexMessage(
      { resource: 'messages', event: 'created', data: { id: 'message-membership-fail' } },
      context
    );
    await handleInboundWebexMessage(
      { resource: 'messages', event: 'created', data: { id: 'message-membership-empty' } },
      context
    );

    assert.equal(collaborators.appendMessageToThreadWindow.mock.callCount(), 0);
  });
});

// ---------------------------------------------------------------------------
// Category: Accepted inbound message → deterministic dispatch (v3 §5, phase 3).
// Verifies an eligible message runs the tagging gate, and that its output
// (plus the deterministic botIsMentioned flag) drives config/staging calls
// through plain controller code — replacing the routing LLM classifier.
// ---------------------------------------------------------------------------

describe('accepted inbound message — deterministic dispatch', () => {
  test('builds thread context and always runs the tagging gate and baseline capture', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const { handleInboundWebexMessage, collaborators } = loadMessageHandler(t);

    await handleInboundWebexMessage(
      { resource: 'messages', event: 'created', data: { id: 'message-accepted' } },
      inboundContext(t)
    );

    assert.equal(collaborators.appendMessageToThreadWindow.mock.callCount(), 1);
    assert.equal(collaborators.dispatchTaggingGate.mock.callCount(), 1);

    const gateArgs = collaborators.dispatchTaggingGate.mock.calls[0].arguments[0];
    assert.equal(gateArgs.spaceId, 'space-1');
    assert.equal(gateArgs.threadKey, '__main__');
    assert.deepEqual(gateArgs.pluginRuntime, { runtime: true });
    assert.equal(gateArgs.message.id, 'message-1');

    assert.equal(collaborators.appendPendingMessage.mock.callCount(), 1);
    assert.deepEqual(collaborators.appendPendingMessage.mock.calls[0].arguments[0].spaceId, 'space-1');
  });

  test('neither config, mention, nor ready: no config or staging call', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const { handleInboundWebexMessage, collaborators } = loadMessageHandler(t);

    await handleInboundWebexMessage(
      { resource: 'messages', event: 'created', data: { id: 'message-accepted' } },
      inboundContext(t)
    );

    assert.equal(collaborators.handleConfigRequest.mock.callCount(), 0);
    assert.equal(collaborators.handleStagePendingBatchRequest.mock.callCount(), 0);
    assert.equal(collaborators.markThreadMessagesProcessed.mock.callCount(), 0);
  });

  test('configRequest from the gate triggers the config flow', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const { handleInboundWebexMessage, collaborators } = loadMessageHandler(t, {
      dispatchTaggingGate: t.mock.fn(async () => ({
        messageTags: { isMentioned: false, configRequest: true },
        pendingThreadWindowDecision: { ready: false, reason: 'Config ask only.' },
      })),
    });

    await handleInboundWebexMessage(
      { resource: 'messages', event: 'created', data: { id: 'message-accepted' } },
      inboundContext(t)
    );

    assert.equal(collaborators.handleConfigRequest.mock.callCount(), 1);
    assert.deepEqual(collaborators.handleConfigRequest.mock.calls[0].arguments[0].spaceId, 'space-1');
    assert.equal(collaborators.handleStagePendingBatchRequest.mock.callCount(), 0);
  });

  test('gate-judged ready flushes the pending slice and stages immediately', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const { handleInboundWebexMessage, collaborators } = loadMessageHandler(t, {
      dispatchTaggingGate: t.mock.fn(async () => ({
        messageTags: { isMentioned: false, configRequest: false },
        pendingThreadWindowDecision: { ready: true, reason: 'Complete ask.' },
      })),
      getPendingSlice: t.mock.fn(async () => [{ id: 'message-1' }, { id: 'message-0' }]),
    });

    await handleInboundWebexMessage(
      { resource: 'messages', event: 'created', data: { id: 'message-accepted' } },
      inboundContext(t)
    );

    assert.equal(collaborators.markThreadMessagesProcessed.mock.callCount(), 1);
    assert.deepEqual(collaborators.markThreadMessagesProcessed.mock.calls[0].arguments[0], {
      spaceId: 'space-1',
      threadKey: '__main__',
      messageIds: ['message-1', 'message-0'],
    });
    assert.equal(collaborators.handleStagePendingBatchRequest.mock.callCount(), 1);
  });

  test('deterministic botIsMentioned alone (gate says not mentioned) still triggers staging', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const webexFetch = t.mock.fn(async (_token, apiPath) =>
      apiPath.startsWith('/messages/')
        ? {
            id: 'message-1',
            roomId: 'space-1',
            roomType: 'group',
            personId: 'person-1',
            mentionedPeople: ['bot-1'],
          }
        : { items: [{ id: 'membership-1' }] }
    );
    const { handleInboundWebexMessage, collaborators } = loadMessageHandler(t, {
      webexFetch,
      dispatchTaggingGate: t.mock.fn(async () => ({
        messageTags: { isMentioned: false, configRequest: false },
        pendingThreadWindowDecision: { ready: false, reason: 'Not ready.' },
      })),
    });

    await handleInboundWebexMessage(
      { resource: 'messages', event: 'created', data: { id: 'message-accepted' } },
      inboundContext(t)
    );

    assert.equal(collaborators.handleStagePendingBatchRequest.mock.callCount(), 1);
  });

  test('a failed tagging gate (returns null) falls back to botIsMentioned alone, never throws', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const { handleInboundWebexMessage, collaborators } = loadMessageHandler(t, {
      dispatchTaggingGate: t.mock.fn(async () => null),
    });

    await handleInboundWebexMessage(
      { resource: 'messages', event: 'created', data: { id: 'message-accepted' } },
      inboundContext(t)
    );

    assert.equal(collaborators.handleStagePendingBatchRequest.mock.callCount(), 0);
    assert.equal(collaborators.handleConfigRequest.mock.callCount(), 0);
  });

  test('skips an empty pending slice without calling markThreadMessagesProcessed', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const { handleInboundWebexMessage, collaborators } = loadMessageHandler(t, {
      dispatchTaggingGate: t.mock.fn(async () => ({
        messageTags: { isMentioned: true, configRequest: false },
        pendingThreadWindowDecision: { ready: false, reason: 'Mentioned.' },
      })),
      getPendingSlice: t.mock.fn(async () => []),
    });

    await handleInboundWebexMessage(
      { resource: 'messages', event: 'created', data: { id: 'message-accepted' } },
      inboundContext(t)
    );

    assert.equal(collaborators.markThreadMessagesProcessed.mock.callCount(), 0);
    assert.equal(collaborators.handleStagePendingBatchRequest.mock.callCount(), 1);
  });

  test('stops before running the gate on a bot-authored message, after recording thread context', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const webexFetch = t.mock.fn(async (_token, apiPath) =>
      apiPath.startsWith('/messages/')
        ? {
            id: 'message-from-bot',
            roomId: 'space-1',
            roomType: 'group',
            personId: 'bot-1',
          }
        : { items: [{ id: 'membership-1' }] }
    );
    const { handleInboundWebexMessage, collaborators } = loadMessageHandler(t, {
      webexFetch,
    });

    await handleInboundWebexMessage(
      { resource: 'messages', event: 'created', data: { id: 'message-from-bot' } },
      inboundContext(t)
    );

    assert.equal(collaborators.appendMessageToThreadWindow.mock.callCount(), 1);
    assert.equal(collaborators.dispatchTaggingGate.mock.callCount(), 0);
    assert.equal(collaborators.appendPendingMessage.mock.callCount(), 0);
  });
});
