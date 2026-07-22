'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { createSpacePrefs } = require('./space-prefs');

function tempWorkspace() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'meeting-prefs-'));
}

test('defaults to auto-join (neverJoin false) when no prefs file exists', () => {
  const workspaceRoot = tempWorkspace();
  const prefs = createSpacePrefs({ workspaceRoot });
  assert.equal(prefs.shouldNeverJoin('room-1'), false);
  assert.deepEqual(prefs.get('room-1'), { neverJoin: false });
});

test('persists neverJoin per space and reloads from disk', () => {
  const workspaceRoot = tempWorkspace();
  const prefs = createSpacePrefs({ workspaceRoot });
  prefs.setNeverJoin('room-a', true, { updatedBy: 'person-1' });
  assert.equal(prefs.shouldNeverJoin('room-a'), true);
  assert.equal(prefs.shouldNeverJoin('room-b'), false);

  const reloaded = createSpacePrefs({ workspaceRoot });
  assert.equal(reloaded.shouldNeverJoin('room-a'), true);
  const stored = reloaded.get('room-a');
  assert.equal(stored.neverJoin, true);
  assert.equal(stored.updatedBy, 'person-1');
  assert.equal(typeof stored.updatedAt, 'string');

  const file = prefs.prefsPath('room-a');
  assert.equal(fs.existsSync(file), true);
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(raw.neverJoin, true);
});

test('setNeverJoin(false) clears the durable opt-out', () => {
  const workspaceRoot = tempWorkspace();
  const prefs = createSpacePrefs({ workspaceRoot });
  prefs.setNeverJoin('room-1', true);
  prefs.setNeverJoin('room-1', false);
  assert.equal(prefs.shouldNeverJoin('room-1'), false);
});
