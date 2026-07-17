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
  return vocative.test(message);
}

module.exports = { DEFAULT_DIRECT_ADDRESS_NAMES, isDirectAddress };
