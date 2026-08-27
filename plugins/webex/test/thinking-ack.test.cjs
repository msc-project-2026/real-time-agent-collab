'use strict';

const assert = require('node:assert/strict');
const { describe, test } = require('node:test');

const { loadWithMocks, makeLog } = require('./helpers.cjs');

// resolveReplyThreadId's own correctness (main vs. existing thread, the
// root-mention lookup) is covered directly in test/send-outbound.test.cjs
// against real storage. Mocked here to the same simple contract — these
// tests are about sendThinkingAck's own wiring, not re-deriving that logic.
async function resolveReplyThreadId({ threadKey, message, isBotMentioned }) {
  if (!isBotMentioned) return null;
  return threadKey === '__main__' ? message?.id : threadKey;
}

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
    [require.resolve('../send')]: {
      sendWebexMessage: async () => ({ id: 'unused' }),
      sendOutboundMessage: collaborators.sendOutboundMessage,
      resolveReplyThreadId,
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
    // Defaults to the happy path (bot was actually @-mentioned) for tests
    // that aren't specifically about threading — see the dedicated
    // threading test below for both branches.
    isBotMentioned: true,
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

  // Webex bots can only see messages that @-mention them — a platform
  // restriction, not a bug (see send.js's resolveReplyThreadId). Posting
  // bare in the main space is the correct, safe fallback when the bot
  // wasn't actually mentioned, not a threading regression.
  test('posts with no parentId when the bot was not actually @-mentioned', async (t) => {
    const sendOutboundMessage = t.mock.fn(async () => ({ id: 'placeholder-1' }));
    const { sendThinkingAck } = loadThinkingAck(t, { sendOutboundMessage });

    await sendThinkingAck(
      baseParams({ threadKey: '__main__', message: { id: 'msg-1' }, isBotMentioned: false })
    );
    assert.equal(sendOutboundMessage.mock.calls[0].arguments[0].parentId, null);
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
