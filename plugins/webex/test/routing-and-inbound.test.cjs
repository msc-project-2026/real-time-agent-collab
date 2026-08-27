'use strict';

const assert = require('node:assert/strict');
const { describe, test } = require('node:test');

const { loadWithMocks, makeLog, mockCalls } = require('./helpers.cjs');

// ---------------------------------------------------------------------------
// Category: Webhook identity dispatch.
// These tests verify OAuth message events and bot attachment actions go to
// separate handlers while unrelated payloads are ignored.
// ---------------------------------------------------------------------------

describe('inbound webhook identity dispatch', () => {
  test('routes only the supported identity/resource combinations', async (t) => {
    const handleInboundWebexMessage = t.mock.fn(async () => 'message-result');
    const handleInboundWebexAttachmentAction = t.mock.fn(async () => 'action-result');
    const handleInboundWebexMembershipDeleted = t.mock.fn(async () => 'membership-result');
    const loaded = loadWithMocks(require.resolve('../inbound/index'), {
      [require.resolve('../inbound/message')]: { handleInboundWebexMessage },
      [require.resolve('../inbound/attachment-actions')]: {
        handleInboundWebexAttachmentAction,
      },
      [require.resolve('../inbound/membership')]: {
        handleInboundWebexMembershipDeleted,
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
    const membershipResult = await loaded.subject.handleInboundWebexWebhook(
      { resource: 'memberships', event: 'deleted', data: { roomId: 'space-1', personId: 'bot-1' } },
      { ...ctx, identity: 'bot' }
    );
    const ignored = await loaded.subject.handleInboundWebexWebhook(
      { resource: 'messages', event: 'deleted' },
      { ...ctx, identity: 'oauth' }
    );

    assert.equal(messageResult, 'message-result');
    assert.equal(actionResult, 'action-result');
    assert.equal(membershipResult, 'membership-result');
    assert.equal(ignored, undefined);
    assert.equal(handleInboundWebexMessage.mock.callCount(), 1);
    assert.equal(handleInboundWebexAttachmentAction.mock.callCount(), 1);
    assert.equal(handleInboundWebexMembershipDeleted.mock.callCount(), 1);
  });
});

// ---------------------------------------------------------------------------
// Category: Membership-deletion cleanup (tidying feature).
// A memberships:deleted webhook carries the full membership object inline
// (no follow-up fetch needed) — only the bot's own removal should trigger
// anything, since another member leaving isn't this plugin's concern.
// ---------------------------------------------------------------------------

describe('membership-deletion cleanup', () => {
  const fsPromises = require('node:fs/promises');
  const { handleInboundWebexMembershipDeleted } = require('../inbound/membership');

  function loadMembershipHandler(t) {
    // node:fs/promises is a builtin — loadWithMocks' require.cache swap
    // doesn't intercept it, so patch the real method directly instead (same
    // pattern as t.mock.method(globalThis, 'fetch', ...) elsewhere).
    const fsRm = t.mock.method(fsPromises, 'rm', async () => undefined);
    return { handleInboundWebexMembershipDeleted, fsRm };
  }

  test('deletes the space\'s collab storage when the bot itself is removed', async (t) => {
    const { handleInboundWebexMembershipDeleted, fsRm } = loadMembershipHandler(t);

    await handleInboundWebexMembershipDeleted(
      {
        resource: 'memberships',
        event: 'deleted',
        data: { roomId: 'space-1', personId: 'bot-1' },
      },
      { botId: 'bot-1', account: { accountId: 'default' }, log: makeLog(t) }
    );

    assert.equal(fsRm.mock.callCount(), 1);
    const [dirArg, optsArg] = fsRm.mock.calls[0].arguments;
    assert.match(dirArg, /space-1$/);
    assert.deepEqual(optsArg, { recursive: true, force: true });
  });

  test('ignores another member leaving the space', async (t) => {
    const { handleInboundWebexMembershipDeleted, fsRm } = loadMembershipHandler(t);

    await handleInboundWebexMembershipDeleted(
      {
        resource: 'memberships',
        event: 'deleted',
        data: { roomId: 'space-1', personId: 'person-1' },
      },
      { botId: 'bot-1', account: { accountId: 'default' }, log: makeLog(t) }
    );

    assert.equal(fsRm.mock.callCount(), 0);
  });

  test('ignores non-deletion or non-membership payloads', async (t) => {
    const { handleInboundWebexMembershipDeleted, fsRm } = loadMembershipHandler(t);
    const ctx = { botId: 'bot-1', account: { accountId: 'default' }, log: makeLog(t) };

    await handleInboundWebexMembershipDeleted(
      { resource: 'memberships', event: 'created', data: { roomId: 'space-1', personId: 'bot-1' } },
      ctx
    );
    await handleInboundWebexMembershipDeleted(
      { resource: 'messages', event: 'deleted', data: { roomId: 'space-1', personId: 'bot-1' } },
      ctx
    );

    assert.equal(fsRm.mock.callCount(), 0);
  });

  test('tolerates a payload missing roomId or personId', async (t) => {
    const { handleInboundWebexMembershipDeleted, fsRm } = loadMembershipHandler(t);
    const ctx = { botId: 'bot-1', account: { accountId: 'default' }, log: makeLog(t) };

    await handleInboundWebexMembershipDeleted(
      { resource: 'memberships', event: 'deleted', data: { personId: 'bot-1' } },
      ctx
    );
    await handleInboundWebexMembershipDeleted(
      { resource: 'memberships', event: 'deleted', data: { roomId: 'space-1' } },
      ctx
    );

    assert.equal(fsRm.mock.callCount(), 0);
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
    // Phase 5: inbound/message.js hands off to runMessageFlow as one opaque
    // step — its own branching (gate/config/respond) is covered separately
    // in test/flow-orchestration.test.cjs.
    runMessageFlow: t.mock.fn(async () => undefined),
    ...overrides,
  };

  const loaded = loadWithMocks(require.resolve('../inbound/message'), {
    [require.resolve('../api')]: { webexFetch: collaborators.webexFetch },
    [require.resolve('../token')]: { getAccessToken: collaborators.getAccessToken },
    [require.resolve('../storage/threads-store')]: {
      appendMessageToThreadWindow:
        collaborators.appendMessageToThreadWindow,
    },
    [require.resolve('../flow/run-message-flow')]: {
      runMessageFlow: collaborators.runMessageFlow,
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
// Category: Accepted inbound message → flow dispatch (v3 phase 5).
// Verifies an eligible message builds thread context and hands off to
// runMessageFlow with the right params. runMessageFlow's own branching
// (gate/config/respond) is covered in test/flow-orchestration.test.cjs.
// ---------------------------------------------------------------------------

describe('accepted inbound message — flow dispatch', () => {
  test('builds thread context and hands off to runMessageFlow', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const { handleInboundWebexMessage, collaborators } = loadMessageHandler(t);

    await handleInboundWebexMessage(
      { resource: 'messages', event: 'created', data: { id: 'message-accepted' } },
      inboundContext(t)
    );

    assert.equal(collaborators.appendMessageToThreadWindow.mock.callCount(), 1);
    assert.equal(collaborators.runMessageFlow.mock.callCount(), 1);

    const flowArgs = collaborators.runMessageFlow.mock.calls[0].arguments[0];
    assert.equal(flowArgs.spaceId, 'space-1');
    assert.equal(flowArgs.threadKey, '__main__');
    assert.equal(flowArgs.message.id, 'message-1');
    assert.equal(flowArgs.botId, 'bot-1');
    assert.deepEqual(flowArgs.account, { accountId: 'default' });
  });

  test('never records or runs the flow for a bot-authored message — recording is now the sender\'s job at send time', async (t) => {
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

    // The bot-message check now runs before appendMessageToThreadWindow, not
    // after — the inbound webhook echo no longer records anything for the
    // bot's own sends (send.js's sendOutboundMessage does that at send time
    // instead), so double-appending — and silently defeating a deliberately
    // unrecorded send like the "thinking" placeholder — can't happen.
    assert.equal(collaborators.appendMessageToThreadWindow.mock.callCount(), 0);
    assert.equal(collaborators.runMessageFlow.mock.callCount(), 0);
  });
});
