'use strict';

const assert = require('node:assert/strict');
const { describe, test } = require('node:test');

const { loadWithMocks } = require('./helpers.cjs');

// resolveReplyThreadId's own correctness (main vs. existing thread, the
// root-mention lookup) is covered directly in test/send-outbound.test.cjs
// against real storage. Mocked here to the same simple contract — these
// tests are about runTaskNotifyStep's own wiring, not re-deriving that logic.
async function resolveReplyThreadId({ threadKey, message, isBotMentioned }) {
  if (!isBotMentioned) return null;
  return threadKey === '__main__' ? message?.id : threadKey;
}

// ---------------------------------------------------------------------------
// Category: task-notify — the deterministic (no model call) step that runs
// after extract settles. Silent for human-assigned tasks (the direct fix for
// the reported bug where respond narrated an already-extracted, human-
// assigned task unprompted); an ack for a self-assigned task that cleared
// the confidence auto-approval bar, an Adaptive Card otherwise.
// ---------------------------------------------------------------------------

describe('runTaskNotifyStep', () => {
  function loadTaskNotify(t, overrides = {}) {
    const collaborators = {
      getTasks: overrides.getTasks ?? (async () => []),
      sendWebexMessage: overrides.sendWebexMessage ?? (async () => ({ id: 'msg-sent' })),
      deriveBoardUrl: overrides.deriveBoardUrl ?? (() => 'https://example.test/board?spaceId=space-1'),
    };
    // sendOutboundMessage's own recording (appendMessageToThreadWindow) is
    // covered directly in send-outbound.test.cjs — here it just delegates
    // straight to the mocked sendWebexMessage, matching the real function's
    // observable send behavior without needing thread-store recording.
    const sendOutboundMessage = t.mock.fn(
      async ({ spaceId, botId, fetchMessageById, recordToThread, log, sendFn, ...sendParams }) =>
        (sendFn ?? collaborators.sendWebexMessage)(sendParams)
    );

    const loaded = loadWithMocks(require.resolve('../processing/task-notify'), {
      [require.resolve('../storage/tasks-store')]: { getTasks: collaborators.getTasks },
      [require.resolve('../send')]: {
        sendWebexMessage: collaborators.sendWebexMessage,
        sendOutboundMessage,
        resolveReplyThreadId,
      },
      [require.resolve('../processing/board-url')]: { deriveBoardUrl: collaborators.deriveBoardUrl },
    });
    t.after(loaded.restore);

    return { ...loaded.subject, collaborators };
  }

  function baseParams(overrides = {}) {
    return {
      spaceId: 'space-1',
      threadKey: '__main__',
      messageIds: ['msg-1'],
      message: { id: 'msg-1' },
      // Defaults to the happy path (bot was actually @-mentioned) for tests
      // that aren't specifically about threading — see the dedicated
      // threading test below for both branches.
      isBotMentioned: true,
      account: { config: { token: 'tok-1' } },
      ...overrides,
    };
  }

  test('silent for a human-assigned task, even if newly created', async (t) => {
    const sendWebexMessage = t.mock.fn(async () => ({ id: 'sent' }));
    const { runTaskNotifyStep } = loadTaskNotify(t, {
      sendWebexMessage,
      getTasks: async () => [
        {
          id: 'task-1',
          assigned: 'mark',
          status: 'unapproved',
          createdAt: '2026-08-25T00:00:00.000Z',
          updatedAt: '2026-08-25T00:00:00.000Z',
        },
      ],
    });

    const result = await runTaskNotifyStep(baseParams());

    assert.equal(sendWebexMessage.mock.callCount(), 0);
    assert.deepEqual(result, { outcome: 'success', notified: [] });
  });

  test('silent for a task that was already delegated before this batch (delegatedAt predates sinceTimestamp)', async (t) => {
    const sendWebexMessage = t.mock.fn(async () => ({ id: 'sent' }));
    const { runTaskNotifyStep } = loadTaskNotify(t, {
      sendWebexMessage,
      getTasks: async () => [
        {
          id: 'task-1',
          assigned: 'agent',
          status: 'in_progress',
          delegation: { target: 'dev-swarm', delegatedAt: '2026-08-20T00:00:00.000Z' },
          createdAt: '2026-08-20T00:00:00.000Z',
          updatedAt: '2026-08-25T00:00:00.000Z',
        },
      ],
    });

    // sinceTimestamp is this batch's extract-step start — well after the
    // old delegation, so this must not re-notify just because the task was
    // touched again (e.g. more evidence added) for an unrelated reason.
    await runTaskNotifyStep(baseParams({ sinceTimestamp: '2026-08-25T00:00:00.000Z' }));

    assert.equal(sendWebexMessage.mock.callCount(), 0);
  });

  test('sends an ack when a task auto-approves on a later patch, not just on creation (createdAt !== updatedAt)', async (t) => {
    const sendWebexMessage = t.mock.fn(async () => ({ id: 'sent' }));
    const { runTaskNotifyStep } = loadTaskNotify(t, {
      sendWebexMessage,
      getTasks: async () => [
        {
          id: 'task-1',
          title: 'Investigate flaky test',
          type: 'research',
          status: 'in_progress',
          assigned: 'agent',
          // Created well before this batch, but only just now delegated —
          // extract/tool.js's auto-approval override fired on a later patch
          // (e.g. a clearer description pushed confidence over the bar),
          // not on the original creation call.
          delegation: { target: 'research-agent', delegatedAt: '2026-08-25T12:00:00.000Z' },
          createdAt: '2026-08-20T00:00:00.000Z',
          updatedAt: '2026-08-25T12:00:00.000Z',
          message_ids: ['msg-1'],
        },
      ],
    });

    const result = await runTaskNotifyStep(baseParams({ sinceTimestamp: '2026-08-25T11:00:00.000Z' }));

    assert.equal(sendWebexMessage.mock.callCount(), 1);
    assert.deepEqual(result.notified, [{ taskId: 'task-1', action: 'ack', coversLastMessage: true }]);
  });

  test('sends a plain markdown ack (not a card) for a newly-created, auto-approved agent task', async (t) => {
    const sendWebexMessage = t.mock.fn(async () => ({ id: 'sent' }));
    const { runTaskNotifyStep } = loadTaskNotify(t, {
      sendWebexMessage,
      getTasks: async () => [
        {
          id: 'task-1',
          title: 'Investigate flaky test',
          type: 'research',
          status: 'in_progress',
          assigned: 'agent',
          delegation: { target: 'research-agent', delegatedAt: '2026-08-25T00:00:00.000Z' },
          createdAt: '2026-08-25T00:00:00.000Z',
          updatedAt: '2026-08-25T00:00:00.000Z',
          message_ids: ['msg-1'],
        },
      ],
    });

    const result = await runTaskNotifyStep(baseParams());

    assert.equal(sendWebexMessage.mock.callCount(), 1);
    const call = sendWebexMessage.mock.calls[0].arguments[0];
    assert.equal(call.attachments, undefined);
    assert.match(call.markdown, /Investigate flaky test/);
    assert.match(call.markdown, /research-agent/);
    assert.match(call.markdown, /https:\/\/example\.test\/board/);
    assert.deepEqual(result.notified, [{ taskId: 'task-1', action: 'ack', coversLastMessage: true }]);
  });

  test('sends an Adaptive Card approval request for a newly-created agent task that did not clear the bar', async (t) => {
    const sendWebexMessage = t.mock.fn(async () => ({ id: 'sent' }));
    const { runTaskNotifyStep } = loadTaskNotify(t, {
      sendWebexMessage,
      getTasks: async () => [
        {
          id: 'task-1',
          title: 'Draft new API shape',
          type: 'design',
          status: 'unapproved',
          assigned: 'agent',
          confidence: 0.4,
          createdAt: '2026-08-25T00:00:00.000Z',
          updatedAt: '2026-08-25T00:00:00.000Z',
          message_ids: ['msg-1'],
        },
      ],
    });

    const result = await runTaskNotifyStep(baseParams());

    assert.equal(sendWebexMessage.mock.callCount(), 1);
    const call = sendWebexMessage.mock.calls[0].arguments[0];
    assert.equal(call.attachments.length, 1);
    assert.equal(call.attachments[0].contentType, 'application/vnd.microsoft.card.adaptive');
    const card = call.attachments[0].content;
    assert.equal(card.type, 'AdaptiveCard');
    assert.deepEqual(
      card.actions.map((a) => a.data.action),
      ['task_card_approve', 'task_card_reject']
    );
    assert.equal(card.actions[0].data.taskId, 'task-1');
    assert.deepEqual(result.notified, [
      { taskId: 'task-1', action: 'approval_card', coversLastMessage: true },
    ]);
  });

  test('threads under the triggering message id for the main space, under threadKey otherwise', async (t) => {
    const sendWebexMessage = t.mock.fn(async () => ({ id: 'sent' }));
    const agentTask = {
      id: 'task-1',
      title: 'x',
      type: 'development',
      status: 'in_progress',
      assigned: 'agent',
      delegation: { target: 'dev-swarm', delegatedAt: '2026-08-25T00:00:00.000Z' },
      createdAt: '2026-08-25T00:00:00.000Z',
      updatedAt: '2026-08-25T00:00:00.000Z',
      message_ids: ['msg-1', 'msg-2'],
    };
    const { runTaskNotifyStep } = loadTaskNotify(t, {
      sendWebexMessage,
      getTasks: async () => [agentTask],
    });

    await runTaskNotifyStep(baseParams({ threadKey: '__main__', message: { id: 'msg-1' } }));
    assert.equal(sendWebexMessage.mock.calls[0].arguments[0].parentId, 'msg-1');

    sendWebexMessage.mock.resetCalls();
    await runTaskNotifyStep(baseParams({ threadKey: 'thread-root-1', message: { id: 'msg-2' } }));
    assert.equal(sendWebexMessage.mock.calls[0].arguments[0].parentId, 'thread-root-1');
  });

  // Webex bots can only see messages that @-mention them — a platform
  // restriction, not a bug (see send.js's resolveReplyThreadId). A message
  // judged addressed via the gate's own semantic inference alone
  // (isBotMentioned: false) is invisible to the bot's own token, so using
  // it — or an existing thread's root — as parentId would 400. Posting bare
  // in the main space is the correct, safe fallback.
  test('posts with no parentId when the bot was not actually @-mentioned, regardless of thread', async (t) => {
    const sendWebexMessage = t.mock.fn(async () => ({ id: 'sent' }));
    const agentTask = {
      id: 'task-1',
      title: 'x',
      type: 'development',
      status: 'in_progress',
      assigned: 'agent',
      delegation: { target: 'dev-swarm', delegatedAt: '2026-08-25T00:00:00.000Z' },
      createdAt: '2026-08-25T00:00:00.000Z',
      updatedAt: '2026-08-25T00:00:00.000Z',
      message_ids: ['msg-1', 'msg-2'],
    };
    const { runTaskNotifyStep } = loadTaskNotify(t, {
      sendWebexMessage,
      getTasks: async () => [agentTask],
    });

    await runTaskNotifyStep(
      baseParams({ threadKey: '__main__', message: { id: 'msg-1' }, isBotMentioned: false })
    );
    assert.equal(sendWebexMessage.mock.calls[0].arguments[0].parentId, null);

    sendWebexMessage.mock.resetCalls();
    await runTaskNotifyStep(
      baseParams({ threadKey: 'thread-root-1', message: { id: 'msg-2' }, isBotMentioned: false })
    );
    assert.equal(sendWebexMessage.mock.calls[0].arguments[0].parentId, null);
  });

  test('does nothing when the account has no Webex token, without throwing', async (t) => {
    const sendWebexMessage = t.mock.fn(async () => ({ id: 'sent' }));
    const { runTaskNotifyStep } = loadTaskNotify(t, {
      sendWebexMessage,
      getTasks: async () => [
        {
          id: 'task-1',
          assigned: 'agent',
          status: 'in_progress',
          delegation: { target: 'dev-swarm', delegatedAt: '2026-08-25T00:00:00.000Z' },
          createdAt: '2026-08-25T00:00:00.000Z',
          updatedAt: '2026-08-25T00:00:00.000Z',
        },
      ],
    });

    const result = await runTaskNotifyStep(baseParams({ account: { config: {} } }));

    assert.equal(sendWebexMessage.mock.callCount(), 0);
    assert.deepEqual(result, { outcome: 'success', notified: [] });
  });

  test('requires spaceId, threadKey, and a messageIds array', async (t) => {
    const { runTaskNotifyStep } = loadTaskNotify(t);

    await assert.rejects(runTaskNotifyStep(baseParams({ spaceId: undefined })), /spaceId is required/);
    await assert.rejects(runTaskNotifyStep(baseParams({ threadKey: undefined })), /threadKey is required/);
    await assert.rejects(
      runTaskNotifyStep(baseParams({ messageIds: undefined })),
      /messageIds array is required/
    );
  });
});
