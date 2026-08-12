'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { createMeetingMinutesManager } = require('./meeting-minutes');

function tempWorkspace(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'meeting-minutes-manager-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function fakeScheduler() {
  const jobs = [];
  return {
    jobs,
    schedule(fn, delay) {
      const handle = {
        delay,
        cleared: false,
        unref() {},
        async fn() {
          handle.cleared = true;
          return fn();
        },
      };
      jobs.push(handle);
      return handle;
    },
    clear(handle) {
      handle.cleared = true;
    },
    next() {
      return jobs.find((job) => !job.cleared);
    },
  };
}

function meeting() {
  return {
    id: 'meeting-1',
    roomId: 'room-1',
    title: 'Release sync',
    start: '2026-08-12T09:00:00Z',
    end: '2026-08-12T10:00:00Z',
  };
}

test('transcript-created webhook is the primary immediate processing path', async (t) => {
  const workspaceRoot = tempWorkspace(t);
  const writes = [];
  let downloads = 0;
  const manager = createMeetingMinutesManager({
    workspaceRoot,
    tokenStore: {
      meetingFetch: async (requestPath) => {
        assert.match(requestPath, /\/meetings\/meeting-1$/);
        return meeting();
      },
      meetingFetchText: async (requestPath) => {
        downloads += 1;
        assert.match(requestPath, /meetingTranscripts\/transcript-1\/download/);
        assert.match(requestPath, /format=vtt/);
        return 'WEBVTT\n\n00:00.000 --> 00:02.000\nSam: Ship on Friday.';
      },
    },
    summarizer: {
      summarize: async ({ transcript }) => {
        assert.match(transcript, /Ship on Friday/);
        return '### Summary\nThe release was discussed.\n\n### Decisions\n- Ship on Friday.';
      },
    },
    minutesStore: {
      appendMeetingMinutes: async (input) => {
        writes.push(input);
        return { written: true, owner: 'acme', repo: 'widgets' };
      },
    },
  });

  const first = await manager.handleTranscriptCreated({
    data: { id: 'transcript-1', meetingId: 'meeting-1' },
  });
  const duplicate = await manager.handleTranscriptCreated({
    data: { id: 'transcript-1', meetingId: 'meeting-1' },
  });

  assert.equal(first.processed, true);
  assert.equal(duplicate.duplicate, true);
  assert.equal(downloads, 1);
  assert.equal(writes.length, 1);
  assert.equal(writes[0].roomId, 'room-1');
  assert.equal((await manager.readJob('meeting-1')).status, 'processed');
});

test('meeting-ended recovery polls until a missed transcript webhook asset appears', async (t) => {
  const workspaceRoot = tempWorkspace(t);
  const scheduler = fakeScheduler();
  const writes = [];
  let transcriptAvailable = false;
  const manager = createMeetingMinutesManager({
    workspaceRoot,
    config: { recoveryDelayMs: 50, recoveryMaxDelayMs: 200, recoveryWindowMs: 10_000 },
    scheduleFn: (fn, delay) => scheduler.schedule(fn, delay),
    clearScheduleFn: (handle) => scheduler.clear(handle),
    tokenStore: {
      meetingFetch: async (requestPath) => {
        if (requestPath.startsWith('/meetingTranscripts?')) {
          return transcriptAvailable
            ? { items: [{ id: 'transcript-1', vttDownloadLink: 'https://webexapis.com/v1/download-vtt' }] }
            : { items: [] };
        }
        throw new Error(`unexpected meetingFetch call: ${requestPath}`);
      },
      meetingFetchText: async () => 'WEBVTT\n\nPat: The migration is approved.',
    },
    summarizer: { summarize: async () => '### Summary\nThe migration was approved.' },
    minutesStore: {
      appendMeetingMinutes: async (input) => {
        writes.push(input);
        return { written: true, owner: 'acme', repo: 'widgets' };
      },
    },
  });

  await manager.rememberMeeting(meeting());
  await manager.handleMeetingEnded({ meetingId: 'meeting-1', roomId: 'room-1' });
  const firstPoll = scheduler.next();
  assert.equal(firstPoll.delay, 50);
  await firstPoll.fn();
  assert.equal(writes.length, 0);

  transcriptAvailable = true;
  const secondPoll = scheduler.next();
  assert.equal(secondPoll.delay, 50);
  await secondPoll.fn();

  assert.equal(writes.length, 1);
  assert.equal(writes[0].transcriptId, 'transcript-1');
  assert.equal((await manager.readJob('meeting-1')).status, 'processed');
});

test('pending recovery jobs are resumed after a gateway restart', async (t) => {
  const workspaceRoot = tempWorkspace(t);
  const firstScheduler = fakeScheduler();
  const dependencies = {
    workspaceRoot,
    config: { recoveryDelayMs: 100, recoveryWindowMs: 10_000 },
    tokenStore: {
      meetingFetch: async () => ({ items: [] }),
      meetingFetchText: async () => '',
    },
    summarizer: { summarize: async () => '' },
    minutesStore: { appendMeetingMinutes: async () => ({}) },
  };
  const first = createMeetingMinutesManager({
    ...dependencies,
    scheduleFn: (fn, delay) => firstScheduler.schedule(fn, delay),
    clearScheduleFn: (handle) => firstScheduler.clear(handle),
  });
  await first.rememberMeeting(meeting());
  await first.handleMeetingEnded({ meetingId: 'meeting-1', roomId: 'room-1' });
  first.dispose();

  const secondScheduler = fakeScheduler();
  const second = createMeetingMinutesManager({
    ...dependencies,
    scheduleFn: (fn, delay) => secondScheduler.schedule(fn, delay),
    clearScheduleFn: (handle) => secondScheduler.clear(handle),
  });
  assert.equal(await second.resumePending(), 1);
  assert.ok(secondScheduler.next());
});
