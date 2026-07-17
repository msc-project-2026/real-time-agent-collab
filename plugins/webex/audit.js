'use strict';

// Gate decision audit log.
//
// Appends one JSON line per gate decision to a .jsonl file in the openclaw
// workspace directory. Captures both accepted AND rejected decisions, so the
// team can see what's being filtered — the false negatives the feedback loop
// (👍/👎) can't capture because those messages were never sent.
//
// File: $OPENCLAW_WORKSPACE_DIR/gate-audit.jsonl
// Each line: { ts, roomId, senderId, type, score, threshold, accepted, system1Override, isMentioned, isDirectAddressed }

const fs = require('node:fs/promises');
const path = require('node:path');

const WORKSPACE_DIR =
  process.env.OPENCLAW_WORKSPACE_DIR ?? '/home/node/.openclaw/workspace';
const AUDIT_FILE = path.join(WORKSPACE_DIR, 'gate-audit.jsonl');

async function logDecision({
  roomId,
  senderId,
  type,
  score,
  threshold,
  accepted,
  system1Override = false,
  isMentioned = false,
  isDirectAddressed = isMentioned,
}) {
  const line =
    JSON.stringify({
      ts: new Date().toISOString(),
      roomId,
      senderId,
      type,
      score: typeof score === 'number' ? parseFloat(score.toFixed(3)) : score,
      threshold: typeof threshold === 'number' ? parseFloat(threshold.toFixed(3)) : threshold,
      accepted,
      system1Override,
      isMentioned,
      isDirectAddressed,
    }) + '\n';

  try {
    await fs.appendFile(AUDIT_FILE, line, 'utf8');
  } catch {
    // Never let logging block message handling
  }
}

module.exports = { logDecision };
