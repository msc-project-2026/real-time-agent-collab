'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { isDirectAddress } = require('./address');

test('recognizes common assistant names at the start of a message', () => {
  assert.equal(isDirectAddress('bot, can you help?'), true);
  assert.equal(isDirectAddress('Hey AI, explain this error.'), true);
  assert.equal(isDirectAddress('@bot, can you help?'), true);
  assert.equal(isDirectAddress('please assistant review the diff'), true);
  assert.equal(isDirectAddress('Chat Bot: what should I do next?'), true);
});

test('recognizes a bot name used as a vocative', () => {
  assert.equal(isDirectAddress('Can you help me, bot?'), true);
  assert.equal(isDirectAddress('Thanks. OpenClaw, can you take a look?'), true);
});

test('does not match incidental words or partial words', () => {
  assert.equal(isDirectAddress('The bot is already in the room.'), false);
  assert.equal(isDirectAddress('We are discussing AI safety.'), false);
  assert.equal(isDirectAddress('Robotics is on the agenda.'), false);
  assert.equal(isDirectAddress('This chatbot implementation is complete.'), false);
});

test('supports a configured bot name and additional aliases', () => {
  assert.equal(isDirectAddress('Nova, are you there?', { botName: 'Nova' }), true);
  assert.equal(isDirectAddress('Helper, please summarize this.', { aliases: ['Helper'] }), true);
  assert.equal(isDirectAddress('Nova is the project codename.', { botName: 'Nova' }), true);
});
