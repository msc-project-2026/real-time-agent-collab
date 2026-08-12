'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { createMinutesStore, parseRepoRef, MINUTES_PATH } = require('./minutes-store');

function response(status, data) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => data,
    text: async () => typeof data === 'string' ? data : JSON.stringify(data),
  };
}

test('parseRepoRef accepts setup-style and GitHub URLs', () => {
  assert.deepEqual(parseRepoRef('owner/repo'), { owner: 'owner', repo: 'repo' });
  assert.deepEqual(parseRepoRef('https://github.com/owner/repo.git'), { owner: 'owner', repo: 'repo' });
  assert.deepEqual(parseRepoRef('git@github.com:owner/repo.git'), { owner: 'owner', repo: 'repo' });
  assert.equal(parseRepoRef('not-a-repo'), null);
});

test('minutes are appended to the mapped primary repo and duplicate meetings are idempotent', async (t) => {
  const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'meeting-minutes-store-'));
  t.after(() => fs.rmSync(workspaceRoot, { recursive: true, force: true }));
  const configDir = path.join(workspaceRoot, 'spaces', 'room-1');
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(
    path.join(configDir, 'config.json'),
    JSON.stringify({ repos: [{ url: 'acme/widgets', primary: true }] }),
    'utf8'
  );

  let remoteContent = null;
  let sha = null;
  let putCalls = 0;
  const fetchImpl = async (url, opts = {}) => {
    assert.match(String(url), /repos\/acme\/widgets\/contents\/\.collab\/meeting%20minutes\.md$/);
    if (opts.method === 'PUT') {
      putCalls += 1;
      const body = JSON.parse(opts.body);
      remoteContent = Buffer.from(body.content, 'base64').toString('utf8');
      sha = `sha-${putCalls}`;
      return response(200, { content: { sha } });
    }
    if (!remoteContent) return response(404, {});
    return response(200, { content: Buffer.from(remoteContent).toString('base64'), sha });
  };
  const store = createMinutesStore({
    workspaceRoot,
    fetchImpl,
    tokenProvider: async () => 'github-token',
  });
  const input = {
    roomId: 'room-1',
    meetingId: 'meeting-1',
    transcriptId: 'transcript-1',
    meeting: { title: 'Weekly sync', start: '2026-08-12T09:00:00Z', end: '2026-08-12T10:00:00Z' },
    minutes: '### Summary\nDiscussed the release.\n\n### Decisions\n- Ship Friday.',
  };

  const first = await store.appendMeetingMinutes(input);
  const second = await store.appendMeetingMinutes(input);

  assert.equal(first.written, true);
  assert.equal(second.duplicate, true);
  assert.equal(putCalls, 1);
  assert.match(remoteContent, /^# Meeting Minutes/);
  assert.match(remoteContent, /webex-meeting-id:meeting-1/);
  assert.match(remoteContent, /## Weekly sync/);
  assert.match(remoteContent, /### Decisions/);
  assert.equal(first.path, MINUTES_PATH);
});
