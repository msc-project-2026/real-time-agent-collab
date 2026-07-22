'use strict';

// Names people commonly use when speaking directly to an assistant. Additional
// names can be supplied by configuration, and the Webex bot display name is
// included automatically by the inbound handler.
const DEFAULT_DIRECT_ADDRESS_NAMES = [
  'bot',
  'ai',
  'assistant',
  'agent',
  'chatbot',
  'chat bot',
  'robot',
  'chatgpt',
  'gpt',
  'copilot',
  'claude',
  'gemini',
  'openclaw',
  'claw',
];

const LEADING_ADDRESS_WORDS = [
  'hey',
  'hi',
  'hello',
  'hiya',
  'yo',
  'ok',
  'okay',
  'please',
  'excuse me',
];

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function normalizeName(value) {
  return String(value ?? '')
    .trim()
    .replace(/\s+/g, ' ')
    .toLowerCase();
}

function namePattern(name) {
  return name
    .split(' ')
    .map(escapeRegExp)
    .join('\\s+');
}

function buildNamePattern(names) {
  return names
    .sort((a, b) => b.length - a.length)
    .map(namePattern)
    .join('|');
}

function getAddressNames({ aliases = [], botName } = {}) {
  return [
    ...DEFAULT_DIRECT_ADDRESS_NAMES,
    ...(Array.isArray(aliases) ? aliases : []),
    botName,
  ]
    .map(normalizeName)
    .filter(Boolean)
    .filter((name, index, names) => names.indexOf(name) === index);
}

// Detect a vocative/direct address without treating every mention of “the bot”
// as a request. Supports forms such as “bot, ...”, “hey AI ...”, and “..., bot?”.
function isDirectAddress(text, options = {}) {
  const message = String(text ?? '').trim();
  if (!message) return false;

  const names = getAddressNames(options);
  if (!names.length) return false;

  const namesPattern = buildNamePattern(names);
  const boundary = '(?=$|[\\s,!?;:.])';
  const leadingWords = LEADING_ADDRESS_WORDS.map(normalizeName)
    .sort((a, b) => b.length - a.length)
    .map(namePattern)
    .join('|');

  const atStart = new RegExp(
    `^(?:(?:${leadingWords})(?:\\s*[,;:!-]\\s*|\\s+))?@?(?:${namesPattern})${boundary}`,
    'iu'
  );
  if (atStart.test(message)) return true;

  // A name in the middle of a sentence is direct address when punctuation
  // marks it as a vocative: “Can you help, bot?” or “Thanks. AI, ...”.
  const vocative = new RegExp(
    `(?:^|[,;.!?]\\s*)@?(?:${namesPattern})(?=\\s*(?:[,!?;:.]|$))`,
    'iu'
  );
  if (vocative.test(message)) return true;

  // A name as the final word is a trailing vocative in casual chat, where the
  // comma is usually dropped: “what do you think agent” or “thanks bot!”.
  // A determiner or preposition before it marks a reference instead (“I'll ask
  // the agent”, “switch to AI”), which must not trigger a reply.
  const referentialLeadIn =
    'the|a|an|this|that|these|those|my|your|our|their|its|some|any|every|each|no|' +
    'of|about|with|via|for|from|on|in|into|by|as|like|to|use|using|called|named';
  const trailingVocative = new RegExp(
    `(?:^|\\s)(?<!\\b(?:${referentialLeadIn})\\s)@?(?:${namesPattern})\\s*[.!?…]*\\s*$`,
    'iu'
  );
  return trailingVocative.test(message);
}

// Loose detection: any word-boundary occurrence of an assistant name, whether
// or not it is grammatically a direct address. Used to tighten the proactivity
// gate rather than to guarantee a reply.
function mentionsName(text, options = {}) {
  const message = String(text ?? '').trim();
  if (!message) return false;

  const names = getAddressNames(options);
  if (!names.length) return false;

  const pattern = new RegExp(
    `(?:^|[^\\p{L}\\p{N}])@?(?:${buildNamePattern(names)})(?=$|[^\\p{L}\\p{N}])`,
    'iu'
  );
  return pattern.test(message);
}

module.exports = { DEFAULT_DIRECT_ADDRESS_NAMES, getAddressNames, isDirectAddress, mentionsName };
