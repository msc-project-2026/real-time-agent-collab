'use strict';

// File: $OPENCLAW_WORKSPACE_DIR/.collab/meeting-links.jsonl
// Each line: { ts, meetingId, meetingNumber, roomId, title, start, joinLink }

const fs = require('node:fs/promises');
const path = require('node:path');

const WORKSPACE_DIR =
  process.env.OPENCLAW_WORKSPACE_DIR ?? '/home/node/.openclaw/workspace';
const OUT_FILE = path.join(WORKSPACE_DIR, '.collab', 'meeting-links.jsonl');

async function recordJoinLink({ meetingId, meetingNumber, roomId, title, start, joinLink }) {
  const line =
    JSON.stringify({
      ts: new Date().toISOString(),
      meetingId,
      meetingNumber,
      roomId,
      title,
      start,
      joinLink,
    }) + '\n';

  await fs.mkdir(path.dirname(OUT_FILE), { recursive: true });
  await fs.appendFile(OUT_FILE, line, 'utf8');
}

module.exports = { recordJoinLink, OUT_FILE };