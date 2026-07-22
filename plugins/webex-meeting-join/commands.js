// Pure text-parsing helpers for chat-triggered meeting controls (leave,
// status, and per-space auto-join opt-in/opt-out). No dependency on the
// primary webex plugin's address.js — this is a small, self-contained
// re-implementation of just what's needed.
'use strict';

const LEAVE_PHRASES = new Set([
  '/meeting leave',
  '/leave meeting',
  'leave meeting',
  'leave the meeting',
  'please leave the meeting',
  'please leave meeting',
  "don't join this meeting",
  'do not join this meeting',
  'please don\'t join this meeting',
  'please do not join this meeting',
]);

const STATUS_PHRASES = new Set(['/meeting', '/meeting status', 'meeting status']);

// Durable per-space auto-join policy. Exact phrases first; freer natural
// language is matched by the patterns below.
const NEVER_JOIN_PHRASES = new Set([
  '/meeting never',
  '/meeting disable',
  '/meeting off',
  'never join',
  'never join meeting',
  'never join the meeting',
  'never join meetings',
  'never join our meetings',
  'never auto join',
  'never auto-join',
  'never auto join meetings',
  'never auto-join meetings',
  "don't join meetings",
  'do not join meetings',
  "don't join our meetings",
  'do not join our meetings',
  "don't auto join",
  "don't auto-join",
  'do not auto join',
  'do not auto-join',
  "don't auto join meetings",
  "don't auto-join meetings",
  'stop joining meetings',
  'stop auto joining',
  'stop auto-joining',
  'stop auto joining meetings',
  'stop auto-joining meetings',
  'please never join meetings',
  'please never join the meeting',
  "please don't join meetings",
  'please do not join meetings',
  'the agent should never join',
  'the agent should never join the meeting',
  'the agent should never join meetings',
  'the bot should never join',
  'the bot should never join the meeting',
  'the bot should never join meetings',
  'agent should never join',
  'agent should never join meetings',
  'you should never join',
  'you should never join meetings',
  'you should never join the meeting',
  'opt out of meetings',
  'opt out of meeting join',
  'opt out of auto join',
  'disable auto join',
  'disable auto-join',
  'disable meeting join',
]);

const ALLOW_JOIN_PHRASES = new Set([
  '/meeting enable',
  '/meeting always',
  '/meeting on',
  'you can join meetings',
  'you can join the meeting',
  'you may join meetings',
  'you may join the meeting',
  'feel free to join meetings',
  'feel free to join',
  'please join meetings again',
  'please join again',
  'start joining meetings',
  'start joining meetings again',
  'start auto joining',
  'start auto-joining',
  'resume joining meetings',
  'resume auto join',
  'resume auto-join',
  'auto join is fine',
  'auto-join is fine',
  'auto join is ok',
  'auto-join is ok',
  'auto join is okay',
  'auto-join is okay',
  'you can auto join',
  'you can auto-join',
  'opt in to meetings',
  'opt in to meeting join',
  'opt in to auto join',
  'enable auto join',
  'enable auto-join',
  'enable meeting join',
  'join meetings again',
  'you can join our meetings',
]);

// Broader NL shapes. Require meeting/auto-join context and/or an explicit
// agent/bot/you subject so ordinary discussion ("we should never join that
// vendor demo") does not flip space policy.
const NEVER_JOIN_PATTERNS = [
  /\b(never|don'?t|do not)\s+auto[ -]?join\b/,
  /\b(never|don'?t|do not)\s+join\b.{0,40}\bmeetings?\b/,
  /\bstop\s+auto[ -]?join(ing)?\b/,
  /\bstop\s+join(ing)?\b.{0,40}\bmeetings?\b/,
  /\b(the\s+)?(agent|bot|assistant)\b.{0,40}\b(should|must)\s+(never|not)\s+(auto[ -]?)?join\b/,
  /\byou\s+should\s+(never|not)\s+(auto[ -]?)?join\b/,
  /\bno\s+more\s+auto[ -]?join(ing)?\b/,
  /\bno\s+more\s+join(ing)?\b.{0,20}\bmeetings?\b/,
  /\bopt\s*out\b.{0,30}\b(meetings?|auto[ -]?join|joining)\b/,
  /\bdisable\b.{0,20}\b(auto[ -]?)?(meeting\s+)?join\b/,
  /\b(please\s+)?(never|don'?t|do not)\s+(let\s+)?(the\s+)?(agent|bot|assistant)\s+join\b/,
];

const ALLOW_JOIN_PATTERNS = [
  /\b(you\s+can|you\s+may|feel\s+free\s+to)\s+(auto[ -]?)?join\b/,
  /\b(start|resume|begin)\s+auto[ -]?join(ing)?\b/,
  /\b(start|resume|begin)\s+join(ing)?\b.{0,40}\bmeetings?\b/,
  /\bauto[ -]?join(ing)?\s+(again|is\s+fine|is\s+ok|is\s+okay)\b/,
  /\bjoin(ing)?\s+(meetings?\s+)?(again|is\s+fine|is\s+ok|is\s+okay)\b/,
  /\bopt\s*in\b.{0,30}\b(meetings?|auto[ -]?join|joining)\b/,
  /\benable\b.{0,20}\b(auto[ -]?)?(meeting\s+)?join\b/,
  /\b(please\s+)?join\b.{0,20}\bmeetings?\b.{0,10}\bagain\b/,
  /\b(the\s+)?(agent|bot|assistant)\b.{0,40}\b(can|may|should)\s+(auto[ -]?)?join\b/,
];

function normalizeCommandText(text) {
  return String(text ?? '')
    .trim()
    .toLowerCase()
    .replace(/['\u2018\u2019]/g, "'")
    .replace(/[.!?…]+$/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function matchesAny(normalized, patterns) {
  return patterns.some((re) => re.test(normalized));
}

function parseCommand(text) {
  const normalized = normalizeCommandText(text);
  if (!normalized) return null;

  if (LEAVE_PHRASES.has(normalized)) return 'leave';
  if (STATUS_PHRASES.has(normalized)) return 'status';
  if (NEVER_JOIN_PHRASES.has(normalized)) return 'never-join';
  if (ALLOW_JOIN_PHRASES.has(normalized)) return 'allow-join';

  // Prefer durable policy over a one-off leave when the wording is clearly
  // about meetings in general / auto-join, not "this" instance.
  if (matchesAny(normalized, NEVER_JOIN_PATTERNS)) return 'never-join';
  if (matchesAny(normalized, ALLOW_JOIN_PATTERNS)) return 'allow-join';

  return null;
}

// Policy commands may be issued without an @mention when the utterance is
// itself an instruction about the bot joining. Leave/status still require
// the normal address rules.
function isJoinPolicyCommand(command) {
  return command === 'never-join' || command === 'allow-join';
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Webex only populates mentionedPeople for a native @mention. People also
// commonly type the bot's name as a plain-text prefix (for example,
// "openclaw leave meeting"), which is what the normal chat plugin recognises
// as a direct address. Treat that exact command form as an address too; do
// not turn arbitrary uses of the bot name into commands.
function stripAddress(text, botName) {
  const s = String(text ?? '').trim();
  if (s.startsWith('@')) return s.replace(/^@\S+\s+/, '').trim();

  const name = String(botName ?? '').trim();
  if (!name) return s;
  const namePattern = escapeRegExp(name).replace(/\s+/g, '\\s+');
  return s.replace(new RegExp(`^${namePattern}(?=$|[\\s,;:!.-])(?:[\\s,;:!.-]+)?`, 'iu'), '').trim();
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
function stripMention(text, botName) {
  return stripAddress(text, botName);
}

module.exports = {
  parseCommand,
  isJoinPolicyCommand,
  isAddressedToBot,
  stripMention,
  stripAddress,
  normalizeCommandText,
};
