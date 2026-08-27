'use strict';

const assert = require('node:assert/strict');
const { describe, test } = require('node:test');

const { loadWithMocks, makeLog, makeTempWorkspace } = require('./helpers.cjs');
const { resolveReplyThreadId } = require('../send');
const { appendMessageToThreadWindow, MAIN_THREAD_KEY } = require('../storage/threads-store');

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

// ---------------------------------------------------------------------------
// Category: resolveReplyThreadId — the shared reply-target decision every
// sender (config card, respond, task-notify, thinking-ack) goes through
// instead of its own inline ternary. Two distinct mention facts matter: for
// the main space, the triggering message's own mention status; for an
// existing thread, the *root's* mention status (stamped onto the thread
// record once, at creation — storage/threads-store.js's root-backfill),
// since a mention in a later reply doesn't establish the bot's token can
// see that thread's root. Exercised here against real storage (not
// mocked), since it's the one place these two facts actually get read.
// ---------------------------------------------------------------------------

describe('resolveReplyThreadId', () => {
  test('main space: targets the message id when mentioned, null otherwise', async (t) => {
    const root = await makeTempWorkspace(t);

    const mentioned = await resolveReplyThreadId({
      spaceId: 'space-1',
      explicitRoot: root,
      threadKey: MAIN_THREAD_KEY,
      message: { id: 'msg-1' },
      isBotMentioned: true,
    });
    assert.equal(mentioned, 'msg-1');

    const unmentioned = await resolveReplyThreadId({
      spaceId: 'space-1',
      explicitRoot: root,
      threadKey: MAIN_THREAD_KEY,
      message: { id: 'msg-1' },
      isBotMentioned: false,
    });
    assert.equal(unmentioned, null);
  });

  test('existing thread: targets the root when the root itself was mentioned, regardless of the triggering message', async (t) => {
    const root = await makeTempWorkspace(t);

    // Root-seed a thread whose root message @-mentions the bot — the
    // triggering message below does NOT, proving the check is against the
    // root, not the triggering message.
    await appendMessageToThreadWindow({
      spaceId: 'space-1',
      explicitRoot: root,
      botId: 'bot-1',
      message: { id: 'reply-1', parentId: 'root-1', personId: 'person-1', mentionedPeople: [] },
      fetchMessageById: async () => ({
        id: 'root-1',
        personId: 'person-1',
        mentionedPeople: ['bot-1'],
      }),
    });

    const result = await resolveReplyThreadId({
      spaceId: 'space-1',
      explicitRoot: root,
      threadKey: 'root-1',
      message: { id: 'reply-1', mentionedPeople: [] },
      isBotMentioned: false,
    });
    assert.equal(result, 'root-1');
  });

  test('existing thread: null when the root itself was never mentioned, even if the triggering message was', async (t) => {
    const root = await makeTempWorkspace(t);

    await appendMessageToThreadWindow({
      spaceId: 'space-1',
      explicitRoot: root,
      botId: 'bot-1',
      message: { id: 'reply-1', parentId: 'root-1', personId: 'person-1', mentionedPeople: ['bot-1'] },
      fetchMessageById: async () => ({
        id: 'root-1',
        personId: 'person-1',
        mentionedPeople: [],
      }),
    });

    const result = await resolveReplyThreadId({
      spaceId: 'space-1',
      explicitRoot: root,
      threadKey: 'root-1',
      message: { id: 'reply-1', mentionedPeople: ['bot-1'] },
      isBotMentioned: true,
    });
    assert.equal(result, null);
  });

  test('existing thread: null when the root-backfill fetch never happened (unconfirmed treated as not-mentioned)', async (t) => {
    const root = await makeTempWorkspace(t);

    // No fetchMessageById provided — root-backfill is skipped entirely
    // (storage/threads-store.js only attempts it when the function exists),
    // so the thread record's rootBotIsMentioned stays at its safe default.
    await appendMessageToThreadWindow({
      spaceId: 'space-1',
      explicitRoot: root,
      botId: 'bot-1',
      message: { id: 'reply-1', parentId: 'root-1', personId: 'person-1', mentionedPeople: ['bot-1'] },
    });

    const result = await resolveReplyThreadId({
      spaceId: 'space-1',
      explicitRoot: root,
      threadKey: 'root-1',
      message: { id: 'reply-1', mentionedPeople: ['bot-1'] },
      isBotMentioned: true,
    });
    assert.equal(result, null);
  });
});
