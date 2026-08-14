'use strict';

const assert = require('node:assert/strict');
const { describe, test } = require('node:test');

const { loadWithMocks, makeLog, mockCalls } = require('./test/helpers.cjs');

function loadRouteHandler(t) {
  const collaborators = {
    appendPendingMessage: t.mock.fn(async () => ({ ok: true })),
    schedulePendingBatchStaging: t.mock.fn(),
    handleStagePendingBatchRequest: t.mock.fn(async () => ({ ok: true })),
    handleConfigRequest: t.mock.fn(async () => undefined),
    handleRecallRequest: t.mock.fn(async () => undefined),
  };

  const loaded = loadWithMocks(require.resolve('./routing/result-handler'), {
    [require.resolve('./batch/append')]: {
      appendPendingMessage: collaborators.appendPendingMessage,
    },
    [require.resolve('./batch/schedule')]: {
      schedulePendingBatchStaging: collaborators.schedulePendingBatchStaging,
    },
    [require.resolve('./batch/staging-handler')]: {
      handleStagePendingBatchRequest: collaborators.handleStagePendingBatchRequest,
    },
    [require.resolve('./config/handle-request')]: {
      handleConfigRequest: collaborators.handleConfigRequest,
    },
    [require.resolve('./recall/handle-request')]: {
      handleRecallRequest: collaborators.handleRecallRequest,
    },
  });
  t.after(loaded.restore);

  return { ...loaded.subject, collaborators };
}

function routeContext(t) {
  return {
    message: { id: 'message-1', roomId: 'space-1', text: 'Please help' },
    account: { accountId: 'default', config: { token: 'bot-token' } },
    log: makeLog(t),
  };
}

// Category: Default route and parse fallback.
// These tests verify every inbound message is durably appended and receives delayed staging when no immediate task route is selected.
describe('default routing behavior', () => {
  test('appends and schedules a normally parsed empty route result', async (t) => {
    const { makeRouteResultHandler, collaborators } = loadRouteHandler(t);
    const context = routeContext(t);

    await makeRouteResultHandler(context)({ text: '{"routes":[]}' });

    assert.equal(collaborators.appendPendingMessage.mock.callCount(), 1);
    assert.deepEqual(
      collaborators.appendPendingMessage.mock.calls[0].arguments[0],
      { spaceId: 'space-1', message: context.message }
    );
    assert.equal(collaborators.schedulePendingBatchStaging.mock.callCount(), 1);
    assert.equal(collaborators.handleStagePendingBatchRequest.mock.callCount(), 0);
  });

  test('falls back to append and delayed staging for unparseable model output', async (t) => {
    const { makeRouteResultHandler, collaborators } = loadRouteHandler(t);
    const context = routeContext(t);

    await makeRouteResultHandler(context)({ text: 'not json' });

    assert.equal(context.log.warn.mock.callCount(), 1);
    assert.equal(collaborators.appendPendingMessage.mock.callCount(), 1);
    assert.equal(collaborators.schedulePendingBatchStaging.mock.callCount(), 1);
  });
});

// Category: Special routing branches.
// These tests verify config and recall can run together while task requests force immediate staging and suppress the delayed timer.
describe('special routing branches', () => {
  test('runs config, recall, and immediate task handling in declared order', async (t) => {
    const { makeRouteResultHandler, collaborators } = loadRouteHandler(t);
    const context = routeContext(t);

    await makeRouteResultHandler(context)({
      text: JSON.stringify({
        routes: [
          { route: 'config_request' },
          { route: 'recall_request' },
          { route: 'task_request' },
        ],
      }),
    });

    assert.equal(collaborators.appendPendingMessage.mock.callCount(), 1);
    assert.deepEqual(collaborators.handleConfigRequest.mock.calls[0].arguments[0], {
      spaceId: 'space-1',
      account: context.account,
      log: context.log,
    });
    assert.equal(collaborators.handleRecallRequest.mock.callCount(), 1);
    assert.equal(collaborators.handleStagePendingBatchRequest.mock.callCount(), 1);
    assert.equal(collaborators.schedulePendingBatchStaging.mock.callCount(), 0);
  });

  test('warns about duplicate and unknown routes without running them', async (t) => {
    const { makeRouteResultHandler, collaborators } = loadRouteHandler(t);
    const context = routeContext(t);

    await makeRouteResultHandler(context)({
      text: JSON.stringify({
        routes: [
          { route: 'recall_request' },
          { route: 'recall_request' },
          { route: 'unsupported' },
        ],
      }),
    });

    assert.equal(context.log.warn.mock.callCount(), 2);
    assert.equal(collaborators.handleRecallRequest.mock.callCount(), 1);
    assert.equal(collaborators.schedulePendingBatchStaging.mock.callCount(), 1);
  });
});

// Category: Routing failure propagation.
// These tests verify storage or downstream-handler failures are logged and returned to the caller instead of being silently swallowed.
describe('routing failure propagation', () => {
  test('logs and rethrows a downstream append failure', async (t) => {
    const { makeRouteResultHandler, collaborators } = loadRouteHandler(t);
    const context = routeContext(t);
    collaborators.appendPendingMessage.mock.mockImplementationOnce(async () => {
      throw new Error('disk unavailable');
    });

    await assert.rejects(
      makeRouteResultHandler(context)({ text: '{"routes":[]}' }),
      /disk unavailable/
    );
    assert.equal(context.log.error.mock.callCount(), 1);
  });
});

// Category: Webhook identity dispatch.
// These tests verify OAuth message events and bot attachment actions go to separate handlers while unrelated payloads are ignored.
describe('inbound webhook identity dispatch', () => {
  test('routes only the supported identity/resource combinations', async (t) => {
    const handleInboundWebexMessage = t.mock.fn(async () => 'message-result');
    const handleInboundWebexAttachmentAction = t.mock.fn(async () => 'action-result');
    const loaded = loadWithMocks(require.resolve('./inbound/index'), {
      [require.resolve('./inbound/message')]: { handleInboundWebexMessage },
      [require.resolve('./inbound/attachment-actions')]: {
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
    appendMessageToThreadContextWindow: t.mock.fn(async () => ({
      threadKey: '__main__',
    })),
    getThread: t.mock.fn(async () => ({
      key: '__main__',
      kind: 'main',
      contextWindow: [],
    })),
    buildRoutingInstruction: t.mock.fn(() => 'routing prompt'),
    callRoutingLlm: t.mock.fn(async () => '{"routes":[]}'),
    routeOutputHandler: t.mock.fn(async () => undefined),
    getPluginRuntime: t.mock.fn(() => ({ runtime: true })),
    ...overrides,
  };
  const makeRouteResultHandler = t.mock.fn(() => collaborators.routeOutputHandler);

  const loaded = loadWithMocks(require.resolve('./inbound/message'), {
    [require.resolve('./api')]: { webexFetch: collaborators.webexFetch },
    [require.resolve('./token')]: { getAccessToken: collaborators.getAccessToken },
    [require.resolve('./context/threads-store')]: {
      appendMessageToThreadContextWindow:
        collaborators.appendMessageToThreadContextWindow,
      getThread: collaborators.getThread,
    },
    [require.resolve('./routing/instruction')]: {
      buildRoutingInstruction: collaborators.buildRoutingInstruction,
    },
    [require.resolve('./routing/direct-llm')]: {
      callRoutingLlm: collaborators.callRoutingLlm,
    },
    [require.resolve('./routing/result-handler')]: { makeRouteResultHandler },
    [require.resolve('./runtime')]: {
      getPluginRuntime: collaborators.getPluginRuntime,
    },
  });
  t.after(loaded.restore);

  return { ...loaded.subject, collaborators, makeRouteResultHandler };
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

// Category: Direct-message policy.
// These tests verify allow, deny, allowlist, and safe-default behavior without invoking external services.
describe('direct-message policy', () => {
  test('supports allow, deny, allowlisted IDs/emails, and safe defaults', () => {
    const { isDmAllowed } = require('./inbound/message');

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

// Category: Early inbound rejection.
// These tests verify irrelevant, duplicate, unauthorised, unconfigured, and non-member messages stop before routing side effects.
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
    assert.equal(collaborators.appendMessageToThreadContextWindow.mock.callCount(), 0);
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

    assert.equal(collaborators.appendMessageToThreadContextWindow.mock.callCount(), 0);
  });
});

// Category: Accepted inbound routing.
// These tests verify an eligible message is contextualised, classified with the configured runtime, and handed to the route-result processor.
describe('accepted inbound routing', () => {
  test('builds thread context and processes non-empty routing output', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const { handleInboundWebexMessage, collaborators, makeRouteResultHandler } =
      loadMessageHandler(t);
    const context = inboundContext(t);

    await handleInboundWebexMessage(
      { resource: 'messages', event: 'created', data: { id: 'message-accepted' } },
      context
    );

    assert.equal(collaborators.appendMessageToThreadContextWindow.mock.callCount(), 1);
    assert.deepEqual(collaborators.getThread.mock.calls[0].arguments[0], {
      spaceId: 'space-1',
      threadKey: '__main__',
      excludeMessageIds: ['message-1'],
    });
    assert.equal(collaborators.buildRoutingInstruction.mock.callCount(), 1);
    assert.deepEqual(collaborators.callRoutingLlm.mock.calls[0].arguments[0], {
      instruction: 'routing prompt',
      pluginRuntime: { runtime: true },
      log: context.log,
    });
    assert.equal(makeRouteResultHandler.mock.callCount(), 1);
    assert.deepEqual(collaborators.routeOutputHandler.mock.calls[0].arguments[0], {
      text: '{"routes":[]}',
    });
  });

  test('does not invoke route handling when the routing provider returns no text', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const { handleInboundWebexMessage, collaborators, makeRouteResultHandler } =
      loadMessageHandler(t, { callRoutingLlm: t.mock.fn(async () => null) });

    await handleInboundWebexMessage(
      { resource: 'messages', event: 'created', data: { id: 'message-no-route' } },
      inboundContext(t)
    );

    assert.equal(collaborators.callRoutingLlm.mock.callCount(), 1);
    assert.equal(makeRouteResultHandler.mock.callCount(), 0);
  });

  test('stops before routing a bot-authored message after recording thread context', async (t) => {
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

    assert.equal(collaborators.appendMessageToThreadContextWindow.mock.callCount(), 1);
    assert.equal(collaborators.callRoutingLlm.mock.callCount(), 0);
  });
});
