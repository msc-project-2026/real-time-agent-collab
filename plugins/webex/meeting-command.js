// Detect meeting-controller commands before they enter the general LLM
// pipeline. The meeting-join plugin owns execution; this module only keeps
// the chat agent from replying as if it could control a meeting.
'use strict';

// Keep phrase detection aligned with plugins/webex-meeting-join/commands.js.
// Prefer requiring that module when present; fall back to a local phrase set
// so the chat plugin still loads if meeting-join is not installed.
let parseMeetingJoinCommand = null;
try {
  ({ parseCommand: parseMeetingJoinCommand } = require('../webex-meeting-join/commands'));
} catch {
  parseMeetingJoinCommand = null;
}

const FALLBACK_COMMANDS = new Set([
  '/meeting',
  '/meeting status',
  '/meeting leave',
  '/leave meeting',
  'leave meeting',
  'leave the meeting',
  'please leave meeting',
  'please leave the meeting',
  '/meeting never',
  '/meeting disable',
  '/meeting off',
  '/meeting enable',
  '/meeting always',
  '/meeting on',
  'never join meetings',
  'never join the meeting',
  "don't join meetings",
  'you can join meetings',
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
  const command = stripLeadingAddress(text, botName);
  if (parseMeetingJoinCommand) {
    return parseMeetingJoinCommand(command) != null;
  }
  const normalized = command
    .toLowerCase()
    .replace(/[.!]+$/, '');
  return FALLBACK_COMMANDS.has(normalized);
}

module.exports = { isMeetingControlCommand, stripLeadingAddress };
