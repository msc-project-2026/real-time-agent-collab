'use strict';

const assert = require('node:assert/strict');
const { describe, test } = require('node:test');

const { loadWithMocks, makeLog } = require('./helpers.cjs');

// ---------------------------------------------------------------------------
// Category: thinking-ack — the deterministic "processing" placeholder sent
// the moment shouldRespond is confirmed, standing in for a typing indicator
// Webex's bot API doesn't have. Always sent with recordToThread: false — a
// placeholder must never resurface in a later prompt.
// ---------------------------------------------------------------------------

function loadThinkingAck(t, overrides = {}) {
  const collaborators = {
    sendOutboundMessage: overrides.sendOutboundMessage ?? (async () => ({ id: 'placeholder-1' })),
  };

  const loaded = loadWithMocks(require.resolve('../processing/thinking-ack'), {
    [require.resolve('../storage/threads-store')]: { MAIN_THREAD_KEY: '__main__' },
    [require.resolve('../send')]: {
      sendWebexMessage: async () => ({ id: 'unused' }),
      sendOutboundMessage: collaborators.sendOutboundMessage,
    },
  });
  t.after(loaded.restore);

  return { ...loaded.subject, collaborators };
}

function baseParams(overrides = {}) {
  return {
    spaceId: 'space-1',
    threadKey: '__main__',
    message: { id: 'msg-1' },
    account: { config: { token: 'tok-1' } },
    botId: 'bot-1',
    log: undefined,
    ...overrides,
  };
}

describe('sendThinkingAck', () => {
  test('sends with recordToThread: false, always', async (t) => {
    const sendOutboundMessage = t.mock.fn(async () => ({ id: 'placeholder-1' }));
    const { sendThinkingAck } = loadThinkingAck(t, { sendOutboundMessage });

    await sendThinkingAck(baseParams());

    assert.equal(sendOutboundMessage.mock.callCount(), 1);
    assert.equal(sendOutboundMessage.mock.calls[0].arguments[0].recordToThread, false);
  });

  test('picks one of the fixed rotating phrases as the markdown', async (t) => {
    const sendOutboundMessage = t.mock.fn(async () => ({ id: 'placeholder-1' }));
    const { sendThinkingAck } = loadThinkingAck(t, { sendOutboundMessage });

    await sendThinkingAck(baseParams());

    const phrases = ['Thinking…', 'One moment…', 'Looking into this…', 'Give me a second…'];
    assert.ok(phrases.includes(sendOutboundMessage.mock.calls[0].arguments[0].markdown));
  });

  test('threads under the triggering message id for the main space, under threadKey otherwise', async (t) => {
    const sendOutboundMessage = t.mock.fn(async () => ({ id: 'placeholder-1' }));
    const { sendThinkingAck } = loadThinkingAck(t, { sendOutboundMessage });

    await sendThinkingAck(baseParams({ threadKey: '__main__', message: { id: 'msg-1' } }));
    assert.equal(sendOutboundMessage.mock.calls[0].arguments[0].parentId, 'msg-1');

    sendOutboundMessage.mock.resetCalls();
    await sendThinkingAck(baseParams({ threadKey: 'thread-root-1', message: { id: 'msg-2' } }));
    assert.equal(sendOutboundMessage.mock.calls[0].arguments[0].parentId, 'thread-root-1');
  });

  test('passes spaceId/botId through, and a fetchMessageById that resolves to the already-known message', async (t) => {
    const sendOutboundMessage = t.mock.fn(async () => ({ id: 'placeholder-1' }));
    const { sendThinkingAck } = loadThinkingAck(t, { sendOutboundMessage });
    const message = { id: 'msg-1' };

    await sendThinkingAck(baseParams({ message, botId: 'bot-1' }));

    const call = sendOutboundMessage.mock.calls[0].arguments[0];
    assert.equal(call.spaceId, 'space-1');
    assert.equal(call.botId, 'bot-1');
    assert.equal(typeof call.fetchMessageById, 'function');
    assert.deepEqual(await call.fetchMessageById(), message);
  });

  test('does nothing when the account has no Webex token, without throwing', async (t) => {
    const sendOutboundMessage = t.mock.fn(async () => ({ id: 'placeholder-1' }));
    const { sendThinkingAck } = loadThinkingAck(t, { sendOutboundMessage });

    const result = await sendThinkingAck(baseParams({ account: { config: {} }, log: makeLog(t) }));

    assert.equal(sendOutboundMessage.mock.callCount(), 0);
    assert.deepEqual(result, { outcome: 'success' });
  });

  test('requires spaceId and threadKey', async (t) => {
    const { sendThinkingAck } = loadThinkingAck(t);

    await assert.rejects(sendThinkingAck(baseParams({ spaceId: undefined })), /spaceId is required/);
    await assert.rejects(sendThinkingAck(baseParams({ threadKey: undefined })), /threadKey is required/);
  });
});
