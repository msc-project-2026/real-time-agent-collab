// Detect meeting-controller commands before they enter the general LLM
// pipeline. The meeting-join plugin owns execution; this module only keeps
// the chat agent from replying as if it could control a meeting.
'use strict';

const COMMANDS = new Set([
  '/meeting',
  '/meeting status',
  '/meeting leave',
  '/leave meeting',
  'leave meeting',
  'leave the meeting',
  'please leave meeting',
  'please leave the meeting',
]);

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function stripLeadingAddress(text, botName) {
  let value = String(text ?? '').trim();
  if (value.startsWith('@')) return value.replace(/^@\S+\s+/, '').trim();

  const name = String(botName ?? '').trim();
  if (!name) return value;
  const namePattern = escapeRegExp(name).replace(/\s+/g, '\\s+');
  value = value.replace(new RegExp(`^${namePattern}(?=$|[\\s,;:!.-])(?:[\\s,;:!.-]+)?`, 'iu'), '');
  return value.trim();
}

function isMeetingControlCommand(text, botName) {
  const command = stripLeadingAddress(text, botName)
    .toLowerCase()
    .replace(/[.!]+$/, '');
  return COMMANDS.has(command);
}

module.exports = { isMeetingControlCommand, stripLeadingAddress };
