'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { createMinutesStore, formatMeetingSection, meetingMarker, resolveProjectRepo } = require('./minutes-store');

test('resolves repositories from environment fallback and rejects an unmapped room', async () => {
  assert.deepEqual(await resolveProjectRepo('room/name', { workspaceRoot: '/tmp/no-such-minutes-workspace', env: { COLLAB_GITHUB_OWNER: 'octo', COLLAB_GITHUB_REPO: 'project' } }), { owner: 'octo', repo: 'project' });
  await assert.rejects(resolveProjectRepo('room', { workspaceRoot: '/tmp/no-such-minutes-workspace', env: {} }), /No primary project repository/);
});

test('formats safe Markdown metadata and an idempotency marker', () => {
  const section = formatMeetingSection({ meetingId: 'meeting`id', transcriptId: 'transcript`id', meeting: { title: 'Release\nReview', actualStart: '09:00', actualEnd: '10:00' }, minutes: '### Summary\nReady' });
  assert.match(section, new RegExp(meetingMarker('meeting`id').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.match(section, /## Release Review/);
  assert.match(section, /`meeting\\`id`/);
  assert.match(section, /### Summary/);
});

test('creates the minutes file through GitHub and retries an optimistic-write conflict', async (t) => {
  const originalSetTimeout = global.setTimeout;
  global.setTimeout = (callback) => { callback(); return {}; };
  t.after(() => { global.setTimeout = originalSetTimeout; });
  const requests = [];
  let reads = 0;
  const store = createMinutesStore({
    workspaceRoot: '/tmp/no-such-minutes-workspace',
    env: { COLLAB_GITHUB_OWNER: 'octo', COLLAB_GITHUB_REPO: 'project', WEBEX_MEETING_MINUTES_GITHUB_TOKEN: 'token' },
    fetchImpl: async (url, options = {}) => {
      requests.push({ url, options });
      if (options.method === 'PUT') return { ok: reads++ === 0 ? false : true, status: reads === 1 ? 409 : 201, text: async () => 'conflict' };
      return { status: 404, ok: false };
    },
  });
  const result = await store.appendMeetingMinutes({ roomId: 'room', meetingId: 'meeting-1', transcriptId: 'transcript-1', meeting: {}, minutes: completeMinutes });
  assert.deepEqual(result, { written: true, owner: 'octo', repo: 'project', path: '.collab/meeting minutes.md' });
  assert.equal(requests.filter((request) => request.options.method === 'PUT').length, 2);
  const firstWrite = JSON.parse(requests.find((request) => request.options.method === 'PUT').options.body);
  assert.match(Buffer.from(firstWrite.content, 'base64').toString('utf8'), /# Meeting Minutes/);
});

const completeMinutes = '### Summary\nDone\n\n### Decisions\n_None recorded._\n\n### Action Items\n_None recorded._\n\n### Open Questions\n_None recorded._';
