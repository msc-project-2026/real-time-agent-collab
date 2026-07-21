'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { parseCommand, isAddressedToBot, stripMention } = require('./commands');

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
