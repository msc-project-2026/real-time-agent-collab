// Pure text-parsing helpers for the chat-triggered "leave the meeting"
// command. No dependency on the primary webex plugin's address.js —
// this is a small, self-contained re-implementation of just what's needed.
'use strict';

const LEAVE_PHRASES = new Set([
  '/meeting leave',
  '/leave meeting',
  'leave meeting',
  'leave the meeting',
  'please leave the meeting',
  'please leave meeting',
]);

const STATUS_PHRASES = new Set(['/meeting', '/meeting status', 'meeting status']);

function parseCommand(text) {
  const normalized = String(text ?? '')
    .trim()
    .toLowerCase()
    .replace(/[.!]+$/, '');
  if (LEAVE_PHRASES.has(normalized)) return 'leave';
  if (STATUS_PHRASES.has(normalized)) return 'status';
  return null;
}

// A message counts as addressed to the bot when it's a direct (1:1) message,
// or in a group space when the bot is @mentioned. Webex webhooks never carry
// message text — callers must have already fetched the full message via
// GET /messages/{id} before calling this.
function isAddressedToBot(message, botId) {
  if (!message) return false;
  if (message.roomType === 'direct') return true;
  return Array.isArray(message.mentionedPeople) && message.mentionedPeople.includes(botId);
}

// Strips a leading "@BotName " mention so "@Bot leave meeting" still matches
// the phrase set above. Only strips when the text actually starts with '@' —
// otherwise a message like "leave the meeting" would lose its first word.
function stripMention(text) {
  const s = String(text ?? '');
  return s.startsWith('@') ? s.replace(/^@\S+\s+/, '').trim() : s.trim();
}

module.exports = { parseCommand, isAddressedToBot, stripMention };
