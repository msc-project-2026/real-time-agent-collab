'use strict';

const assert = require('node:assert/strict');
const { describe, test } = require('node:test');

const { loadWithMocks, makeLog } = require('./helpers.cjs');

// ---------------------------------------------------------------------------
// Category: sendOutboundMessage — the single choke point every sender in
// this plugin (the model's own replies via channel.js, and this plugin's
// own deterministic sends) goes through instead of calling `sendFn`
// directly, so recording to the thread window is never something a caller
// has to remember or reimplement. sendWebexMessage itself stays untouched
// and pure — this is a thin wrapper around it, not a replacement.
// ---------------------------------------------------------------------------

function loadSendOutbound(t, overrides = {}) {
  const collaborators = {
    // sendWebexMessage isn't independently injectable — it's a local
    // function inside send.js, only reachable via the real webexFetch call
    // it makes. Mocked here purely so the "defaults to the real
    // sendWebexMessage" test can observe that it was reached.
    webexFetch: overrides.webexFetch ?? (async () => ({ id: 'sent-1', roomId: 'space-1' })),
    appendMessageToThreadWindow: overrides.appendMessageToThreadWindow ?? (async () => undefined),
  };

  const loaded = loadWithMocks(require.resolve('../send'), {
    [require.resolve('../api')]: { webexFetch: collaborators.webexFetch },
    [require.resolve('../storage/threads-store')]: {
      appendMessageToThreadWindow: collaborators.appendMessageToThreadWindow,
    },
  });
  t.after(loaded.restore);

  return { ...loaded.subject, collaborators };
}

describe('sendOutboundMessage', () => {
  test('calls sendFn to actually send, then records the returned message by default', async (t) => {
    const sendFn = t.mock.fn(async () => ({ id: 'sent-1', roomId: 'space-1', personId: 'bot-1' }));
    const appendMessageToThreadWindow = t.mock.fn(async () => undefined);
    const { sendOutboundMessage } = loadSendOutbound(t, { appendMessageToThreadWindow });

    const result = await sendOutboundMessage({
      sendFn,
      spaceId: 'space-1',
      botId: 'bot-1',
      log: makeLog(t),
      token: 'tok-1',
      to: 'space-1',
      markdown: 'hello',
    });

    assert.deepEqual(result, { id: 'sent-1', roomId: 'space-1', personId: 'bot-1' });
    assert.equal(sendFn.mock.callCount(), 1);
    assert.deepEqual(sendFn.mock.calls[0].arguments[0], {
      token: 'tok-1',
      to: 'space-1',
      markdown: 'hello',
    });
    assert.equal(appendMessageToThreadWindow.mock.callCount(), 1);
    const recordArgs = appendMessageToThreadWindow.mock.calls[0].arguments[0];
    assert.equal(recordArgs.spaceId, 'space-1');
    assert.deepEqual(recordArgs.message, { id: 'sent-1', roomId: 'space-1', personId: 'bot-1' });
    assert.equal(recordArgs.botId, 'bot-1');
    assert.equal(recordArgs.fetchMessageById, undefined);
  });

  test('defaults sendFn to the real sendWebexMessage when none is given', async (t) => {
    const webexFetch = t.mock.fn(async () => ({ id: 'sent-1' }));
    const { sendOutboundMessage } = loadSendOutbound(t, { webexFetch });

    await sendOutboundMessage({ spaceId: 'space-1', botId: null, token: 'tok-1', to: 'space-1', markdown: 'hi' });

    // Reaching the real webexFetch call (not just a mocked sendFn) confirms
    // sendOutboundMessage's own default is the real sendWebexMessage.
    assert.equal(webexFetch.mock.callCount(), 1);
    assert.equal(webexFetch.mock.calls[0].arguments[0], 'tok-1');
    assert.equal(webexFetch.mock.calls[0].arguments[1], '/messages');
  });

  test('skips recording entirely when recordToThread is false', async (t) => {
    const appendMessageToThreadWindow = t.mock.fn(async () => undefined);
    const { sendOutboundMessage } = loadSendOutbound(t, { appendMessageToThreadWindow });

    await sendOutboundMessage({
      sendFn: async () => ({ id: 'sent-1' }),
      spaceId: 'space-1',
      botId: 'bot-1',
      recordToThread: false,
      token: 'tok-1',
      to: 'space-1',
      markdown: 'thinking...',
    });

    assert.equal(appendMessageToThreadWindow.mock.callCount(), 0);
  });

  test('skips recording when botId is missing, even if recordToThread is true', async (t) => {
    const appendMessageToThreadWindow = t.mock.fn(async () => undefined);
    const { sendOutboundMessage } = loadSendOutbound(t, { appendMessageToThreadWindow });

    await sendOutboundMessage({
      sendFn: async () => ({ id: 'sent-1' }),
      spaceId: 'space-1',
      botId: null,
      token: 'tok-1',
      to: 'space-1',
      markdown: 'hi',
    });

    assert.equal(appendMessageToThreadWindow.mock.callCount(), 0);
  });

  test('a recording failure logs a warning but does not reject the call or lose the send result', async (t) => {
    const appendMessageToThreadWindow = t.mock.fn(async () => {
      throw new Error('disk full');
    });
    const { sendOutboundMessage } = loadSendOutbound(t, { appendMessageToThreadWindow });
    const log = makeLog(t);

    const result = await sendOutboundMessage({
      sendFn: async () => ({ id: 'sent-1' }),
      spaceId: 'space-1',
      botId: 'bot-1',
      log,
      token: 'tok-1',
      to: 'space-1',
      markdown: 'hi',
    });

    assert.deepEqual(result, { id: 'sent-1' });
    assert.equal(log.warn.mock.callCount(), 1);
  });

  test('passes fetchMessageById through to the recording call untouched', async (t) => {
    const appendMessageToThreadWindow = t.mock.fn(async () => undefined);
    const { sendOutboundMessage } = loadSendOutbound(t, { appendMessageToThreadWindow });
    const fetchMessageById = async () => ({ id: 'root-1' });

    await sendOutboundMessage({
      sendFn: async () => ({ id: 'sent-1' }),
      spaceId: 'space-1',
      botId: 'bot-1',
      fetchMessageById,
      token: 'tok-1',
      to: 'space-1',
      markdown: 'hi',
    });

    assert.equal(appendMessageToThreadWindow.mock.calls[0].arguments[0].fetchMessageById, fetchMessageById);
  });
});
