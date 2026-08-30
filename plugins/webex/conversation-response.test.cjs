'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  sendResponseDecision,
} = require('./processing/conversations/result-handler');

const account = {
  accountId: 'default',
  config: { token: 'bot-token' },
};

test('sendResponseDecision posts a required response to the Webex space', async () => {
  let request;

  const result = await sendResponseDecision({
    responseDecision: {
      needed: true,
      message: 'Alive and kicking! 👋',
      replyToId: 'parent-message-id',
    },
    spaceId: 'room-id',
    account,
    sendMessage: async (args) => {
      request = args;
      return { id: 'sent-message-id' };
    },
  });

  assert.deepEqual(request, {
    token: 'bot-token',
    to: 'room-id',
    text: 'Alive and kicking! 👋',
    parentId: 'parent-message-id',
  });
  assert.deepEqual(result, { sent: true, messageId: 'sent-message-id' });
});

test('sendResponseDecision skips delivery when no response is needed', async () => {
  let called = false;

  const result = await sendResponseDecision({
    responseDecision: { needed: false },
    spaceId: 'room-id',
    account,
    sendMessage: async () => {
      called = true;
    },
  });

  assert.equal(called, false);
  assert.deepEqual(result, { sent: false });
});
