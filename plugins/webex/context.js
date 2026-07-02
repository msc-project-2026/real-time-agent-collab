'use strict';

// Sliding window of recent messages per room, fed to the gate as conversation context.
// Gives the gate the thread preceding the current message so it can score relevance
// in context rather than in isolation (e.g. "should we?" only makes sense mid-thread).

const MAX_MESSAGES = 5;

// Map<roomId, Array<{ text, senderName }>>
const history = new Map();

function recordMessage(roomId, { text, senderName }) {
  const msgs = history.get(roomId) ?? [];
  msgs.push({
    text: String(text ?? '').slice(0, 300),
    senderName: String(senderName ?? 'unknown'),
  });
  if (msgs.length > MAX_MESSAGES) msgs.shift();
  history.set(roomId, msgs);
}

// Returns the last MAX_MESSAGES messages for this room, oldest first.
// Does NOT include the current message — caller appends that separately.
function getRecentMessages(roomId) {
  return history.get(roomId) ?? [];
}

module.exports = { recordMessage, getRecentMessages };
