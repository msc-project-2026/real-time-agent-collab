'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { parseCommand, isJoinPolicyCommand, isExplicitSlashCommand, isAddressedToBot, stripMention } = require('./commands');

test('parseCommand recognizes leave and status phrasing, case/punctuation-insensitively', () => {
  assert.equal(parseCommand('leave meeting'), 'leave');
  assert.equal(parseCommand('Leave the meeting.'), 'leave');
  assert.equal(parseCommand('/meeting leave'), 'leave');
  assert.equal(parseCommand('/meeting'), 'status');
  assert.equal(parseCommand('/meeting status'), 'status');
  assert.equal(parseCommand('what is the weather'), null);
  assert.equal(parseCommand(''), null);
  assert.equal(parseCommand(undefined), null);
});

test('parseCommand recognizes natural-language never-join and allow-join policy', () => {
  assert.equal(parseCommand('never join meetings'), 'never-join');
  assert.equal(parseCommand('The agent should never join the meeting.'), 'never-join');
  assert.equal(parseCommand("don't join our meetings"), 'never-join');
  assert.equal(parseCommand('please stop auto-joining meetings'), 'never-join');
  assert.equal(parseCommand('/meeting never'), 'never-join');
  assert.equal(parseCommand('you can join meetings'), 'allow-join');
  assert.equal(parseCommand('Feel free to join meetings again!'), 'allow-join');
  assert.equal(parseCommand('/meeting enable'), 'allow-join');
  assert.equal(parseCommand('the agent can join meetings'), 'allow-join');
});

test('parseCommand does not treat ordinary discussion as join policy', () => {
  assert.equal(parseCommand('we should never join that vendor demo as a team'), null);
  assert.equal(parseCommand('Can OpenClaw leave a meeting?'), null);
  assert.equal(parseCommand('join the meeting when you can'), null);
});

test('parseCommand recognizes an explicit one-off join request', () => {
  assert.equal(parseCommand('/meeting join'), 'join');
  assert.equal(parseCommand('join the meeting'), 'join');
  assert.equal(parseCommand('join meeting'), 'join');
  assert.equal(parseCommand('Please join this meeting!'), 'join');
  assert.equal(parseCommand('can you join the meeting'), 'join');
  assert.equal(parseCommand('join the current meeting now'), 'join');
});

test('durable policy phrasing still wins over one-off join wording', () => {
  assert.equal(parseCommand('you can join meetings'), 'allow-join');
  assert.equal(parseCommand('join meetings again'), 'allow-join');
  assert.equal(parseCommand("don't join this meeting"), 'leave');
});

test('isJoinPolicyCommand flags durable opt-in/opt-out only', () => {
  assert.equal(isJoinPolicyCommand('never-join'), true);
  assert.equal(isJoinPolicyCommand('allow-join'), true);
  assert.equal(isJoinPolicyCommand('leave'), false);
  assert.equal(isJoinPolicyCommand('status'), false);
  assert.equal(isJoinPolicyCommand('join'), false);
  assert.equal(isJoinPolicyCommand(null), false);
});

test('isExplicitSlashCommand accepts slash forms and nothing else', () => {
  assert.equal(isExplicitSlashCommand('/meeting join'), true);
  assert.equal(isExplicitSlashCommand('/meeting leave'), true);
  assert.equal(isExplicitSlashCommand('/leave meeting'), true);
  assert.equal(isExplicitSlashCommand('join the meeting'), false);
  assert.equal(isExplicitSlashCommand('leave meeting'), false);
});

test('isAddressedToBot treats direct messages as always addressed', () => {
  assert.equal(isAddressedToBot({ roomType: 'direct' }, 'bot-id'), true);
});

test('isAddressedToBot requires a mention in a group space', () => {
  assert.equal(isAddressedToBot({ roomType: 'group', mentionedPeople: ['bot-id'] }, 'bot-id'), true);
  assert.equal(isAddressedToBot({ roomType: 'group', mentionedPeople: ['someone-else'] }, 'bot-id'), false);
  assert.equal(isAddressedToBot({ roomType: 'group' }, 'bot-id'), false);
  assert.equal(isAddressedToBot(null, 'bot-id'), false);
});

test('stripMention only strips a leading @mention token, not a real first word', () => {
  assert.equal(stripMention('@MeetingBot leave meeting'), 'leave meeting');
  assert.equal(stripMention('leave the meeting'), 'leave the meeting');
  assert.equal(stripMention(''), '');
});

test('stripMention accepts the bot display name as a plain-text command address', () => {
  assert.equal(stripMention('openclaw leave meeting', 'OpenClaw'), 'leave meeting');
  assert.equal(stripMention('OpenClaw, please leave the meeting.', 'OpenClaw'), 'please leave the meeting.');
  assert.equal(stripMention('The openclaw meeting is active', 'OpenClaw'), 'The openclaw meeting is active');
});
