'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { mkdtemp, readFile, rm } = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { parseInvitation, redactInvitation, EncryptedState } = require('../dist/service.cjs');

const INVITATION = `Meeting link:
https://meet1753491728593-7008.webex.com/meet1753491728593-7008/j.php?MTID=m0ceda7e17bef71adc7e2f13b63c51476

Meeting number:
2378 512 0739

Meeting password:
tM9mpFci5C8

Join from a video system or application
Dial 23785120739@meet1753491728593-7008.webex.com

Meeting password for video system
86967324`;

test('parses the ordinary Webex password and ignores video-system credentials', () => {
  const invitation = parseInvitation(INVITATION);
  assert.equal(invitation.joinLink.startsWith('https://meet1753491728593-7008.webex.com/'), true);
  assert.equal(invitation.password, 'tM9mpFci5C8');
  assert.equal(invitation.meetingNumber, '2378 512 0739');
});

test('redacts the entire stored invitation from agent-bound text', () => {
  const invitation = parseInvitation(INVITATION);
  const redacted = redactInvitation(`@bot join the meeting\n${INVITATION}`, invitation);
  assert.match(redacted, /@bot join the meeting/);
  assert.doesNotMatch(redacted, /tM9mpFci5C8|86967324|meet1753491728593/);
});

test('rejects non-Webex and malformed invitations', () => {
  assert.equal(parseInvitation('Meeting link: https://example.com/join\nMeeting password: x'), null);
  assert.equal(parseInvitation('Meeting link: https://meet.webex.com/j.php\n'), null);
});

test('encrypted state round-trips without plaintext credentials on disk', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'meeting-join-test-'));
  try {
    const statePath = path.join(dir, 'state.enc');
    const key = Buffer.alloc(32, 7).toString('base64');
    const store = new EncryptedState(key, statePath);
    const state = {
      version: 1,
      invitations: { room: { joinLink: 'https://meet.example.webex.com/j.php', password: 'secret-pass', discoveredAt: 'now' } },
      sessions: {},
      token: { accessToken: 'access-secret', refreshToken: 'refresh-secret', expiresAt: 1 },
    };
    await store.save(state);
    const raw = await readFile(statePath, 'utf8');
    assert.doesNotMatch(raw, /secret-pass|access-secret|refresh-secret/);
    assert.deepEqual(await store.load(), state);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
