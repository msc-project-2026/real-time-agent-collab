'use strict';

// Tracks bot-sent message IDs and handles Webex reaction events for feedback logging.
//
// When someone reacts with 👍 or 👎 to a message the bot sent, we log a structured
// entry to .collab/feedback.md so the team can audit and tune gateThreshold over time.
//
// Message metadata is held in memory for PURGE_AFTER_MS (2h), then discarded.
// The bot's own message ID is not known until after the Webex API returns it —
// inbound.js captures it from the POST /messages response and calls trackMessage().

const PURGE_AFTER_MS = 2 * 60 * 60 * 1000; // 2 hours
const POSITIVE_REACTIONS = new Set(['thumbs_up', 'like', '+1', '👍']);
const NEGATIVE_REACTIONS = new Set(['thumbs_down', 'dislike', '-1', '👎']);

// Map<messageId, { roomId, gateScore, interventionType, sentAt }>
const sentMessages = new Map();

let _lastPurge = Date.now();

function trackMessage(messageId, { roomId, gateScore, interventionType }) {
  sentMessages.set(messageId, {
    roomId,
    gateScore,
    interventionType,
    sentAt: Date.now(),
  });
  maybePurge();
}

// Called from inbound.js when payload.resource === 'reactions'.
// appendToFile: the appendToFile fn from lib/collab-cache.js, passed in to avoid
// a circular dependency and to keep feedback.js testable in isolation.
async function handleReaction(payload, { log, appendToFile }) {
  if (payload.event !== 'created') return;

  const data = payload.data ?? {};
  const messageId = data.messageId;
  const reaction = data.reaction;
  const personEmail = data.personEmail ?? data.personId ?? 'unknown';
  const roomId = data.roomId;

  if (!messageId || !reaction || !roomId) return;

  const meta = sentMessages.get(messageId);
  if (!meta) return; // not a message we sent, or already purged

  const isPositive = POSITIVE_REACTIONS.has(reaction);
  const isNegative = NEGATIVE_REACTIONS.has(reaction);
  if (!isPositive && !isNegative) return; // ignore other reactions

  const sentiment = isPositive ? '👍 positive' : '👎 negative';
  const date = new Date().toISOString().slice(0, 10);
  const entry = [
    `- **${date}** [${personEmail}]: ${sentiment} reaction on a proactive message`,
    `  - Gate score: ${meta.gateScore?.toFixed(2) ?? 'n/a'} | Type: ${meta.interventionType ?? 'n/a'}`,
  ].join('\n');

  log?.info?.(
    `[webex:feedback] ${sentiment} on msgId=${messageId} ` +
      `score=${meta.gateScore?.toFixed(2)} type=${meta.interventionType}`
  );

  try {
    await appendToFile(roomId, 'feedback.md', entry);
  } catch (err) {
    log?.warn?.(`[webex:feedback] could not write to feedback.md: ${err?.message ?? err}`);
  }
}

function maybePurge() {
  const now = Date.now();
  if (now - _lastPurge < 10 * 60 * 1000) return; // purge at most every 10 min
  _lastPurge = now;
  for (const [id, meta] of sentMessages) {
    if (now - meta.sentAt > PURGE_AFTER_MS) sentMessages.delete(id);
  }
}

module.exports = { trackMessage, handleReaction };
