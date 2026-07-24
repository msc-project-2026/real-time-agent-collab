// Durable per-space meeting-join preferences. Default is auto-join (neverJoin
// false). Opt-out survives restarts and applies to every future meeting in
// that Webex space.
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const ROOT = '.collab';
const DEFAULT_WORKSPACE_ROOT = '/home/node/.openclaw/workspace';
const PREFS_FILE = 'meeting-prefs.json';

function getWorkspaceRoot(explicitRoot) {
  return explicitRoot ?? process.env.OPENCLAW_WORKSPACE_DIR ?? DEFAULT_WORKSPACE_ROOT;
}

function safeSegment(value) {
  return String(value).replace(/[^a-zA-Z0-9._-]/g, '_');
}

function prefsPath(roomId, explicitRoot) {
  return path.join(getWorkspaceRoot(explicitRoot), ROOT, 'spaces', safeSegment(roomId), PREFS_FILE);
}

function createSpacePrefs({ workspaceRoot = null, log = null } = {}) {
  // Map<roomId, { neverJoin: boolean, updatedAt?: string, updatedBy?: string }>
  const cache = new Map();

  function readDisk(roomId) {
    const file = prefsPath(roomId, workspaceRoot);
    try {
      const raw = fs.readFileSync(file, 'utf8');
      const parsed = JSON.parse(raw);
      return {
        neverJoin: Boolean(parsed?.neverJoin),
        updatedAt: typeof parsed?.updatedAt === 'string' ? parsed.updatedAt : undefined,
        updatedBy: typeof parsed?.updatedBy === 'string' ? parsed.updatedBy : undefined,
      };
    } catch (err) {
      if (err?.code !== 'ENOENT') {
        log?.warn?.(`[webex-meeting-join] failed to read meeting prefs for room=${roomId}: ${err?.message ?? err}`);
      }
      return { neverJoin: false };
    }
  }

  function writeDisk(roomId, prefs) {
    const file = prefsPath(roomId, workspaceRoot);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `${JSON.stringify(prefs, null, 2)}\n`, 'utf8');
  }

  function get(roomId) {
    if (!roomId) return { neverJoin: false };
    if (!cache.has(roomId)) cache.set(roomId, readDisk(roomId));
    return cache.get(roomId);
  }

  function shouldNeverJoin(roomId) {
    return get(roomId).neverJoin === true;
  }

  function setNeverJoin(roomId, neverJoin, { updatedBy = null } = {}) {
    if (!roomId) throw new Error('roomId is required');
    const prefs = {
      neverJoin: Boolean(neverJoin),
      updatedAt: new Date().toISOString(),
      ...(updatedBy ? { updatedBy: String(updatedBy) } : {}),
    };
    cache.set(roomId, prefs);
    try {
      writeDisk(roomId, prefs);
    } catch (err) {
      log?.error?.(`[webex-meeting-join] failed to persist meeting prefs for room=${roomId}: ${err?.message ?? err}`);
      throw err;
    }
    return prefs;
  }

  // Test helper — drop in-memory cache (disk untouched).
  function clearCache() {
    cache.clear();
  }

  return { get, shouldNeverJoin, setNeverJoin, prefsPath: (roomId) => prefsPath(roomId, workspaceRoot), clearCache };
}

module.exports = { createSpacePrefs, prefsPath, getWorkspaceRoot, safeSegment };
