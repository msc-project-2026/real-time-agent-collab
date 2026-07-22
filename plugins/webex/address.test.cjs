'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { isDirectAddress, mentionsName } = require('./address');

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

test('recognizes a trailing vocative without a comma', () => {
  assert.equal(isDirectAddress('what do you think agent'), true);
  assert.equal(isDirectAddress('thanks bot!'), true);
  assert.equal(isDirectAddress('can you take a look openclaw?'), true);
});

test('trailing name after a determiner or preposition is a reference, not an address', () => {
  assert.equal(isDirectAddress("I'll ask the agent"), false);
  assert.equal(isDirectAddress('we should switch to AI'), false);
  assert.equal(isDirectAddress('this looks like a job for the bot'), false);
});

test('mentionsName matches names anywhere on word boundaries', () => {
  assert.equal(mentionsName('maybe the agent knows the answer'), true);
  assert.equal(mentionsName('does the ai have an opinion on this?'), true);
  assert.equal(mentionsName('Robotics is on the agenda.'), false);
  assert.equal(mentionsName('This chatbot implementation is complete.'), true);
  assert.equal(mentionsName('we said nothing relevant here'), false);
});

test('supports a configured bot name and additional aliases', () => {
  assert.equal(isDirectAddress('Nova, are you there?', { botName: 'Nova' }), true);
  assert.equal(isDirectAddress('Helper, please summarize this.', { aliases: ['Helper'] }), true);
  assert.equal(isDirectAddress('Nova is the project codename.', { botName: 'Nova' }), true);
});
